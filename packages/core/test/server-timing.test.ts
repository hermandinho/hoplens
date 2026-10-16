// Server-Timing + x-hoplens-trace on traced dev responses, and its absence in production.
// Installs the real http emit hook in this test process (each vitest file runs isolated).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { hookWriteHead, installHttpHook, serverTimingEnabled, serverTimingValue } from "../src/capture";
import { makeRedactor } from "../src/serialize";
import { TraceStore } from "../src/store";
import type { SpanRecord } from "../src/types";
import { db, fetchSpan, makeTrace, span } from "./helpers";

/* ------------------------------------------------------------- unit level */

describe("serverTimingValue", () => {
  test("innermost-span budget over [0, elapsed]; empty buckets skipped; total always present", () => {
    const root = span({ kind: "request", start: 0, end: 100 });
    const fn = span({ kind: "function", name: "load", parentId: root.id, start: 0, end: 60 });
    const spans: SpanRecord[] = [
      root,
      fn,
      db(fn.id, 10, 30, "select 1"),
      fetchSpan(fn.id, 30, 50, "https://x.test/a"),
      // Overlaps the db call: Promise.all must not double count.
      fetchSpan(fn.id, 20, 30, "https://x.test/b"),
    ];
    const v = serverTimingValue(spans, 60);
    expect(v).toBe(
      'db;desc="Database";dur=10, ext;desc="External fetch";dur=30, fn;desc="Your code (self)";dur=20, total;desc="Hoplens: to headers";dur=60',
    );
  });

  test("no spans yet, or too many: total only", () => {
    expect(serverTimingValue([], 12.345)).toBe('total;desc="Hoplens: to headers";dur=12.3');
    const many = Array.from({ length: 2001 }, (_, i) => span({ kind: "function", start: i, end: i + 1 }));
    expect(serverTimingValue(many, 5)).toBe('total;desc="Hoplens: to headers";dur=5');
  });

  test("enabled by default, off with serverTiming:false, never in production", () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      expect(serverTimingEnabled({ options: {} as any })).toBe(true);
      expect(serverTimingEnabled({ options: { serverTiming: false } as any })).toBe(false);
      process.env.NODE_ENV = "production";
      process.env.HOPLENS_FORCE = "1";
      expect(serverTimingEnabled({ options: { serverTiming: true } as any })).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
      Reflect.deleteProperty(process.env, "HOPLENS_FORCE");
    }
  });

  test("skips when headers were already sent, and never throws into the response", () => {
    const calls: unknown[][] = [];
    const fake: any = {
      headersSent: true,
      setHeader: () => {
        throw new Error("must not be called");
      },
      writeHead: (...a: unknown[]) => calls.push(a),
    };
    hookWriteHead(makeTrace([]), fake, 0);
    fake.writeHead(200);
    expect(calls).toEqual([[200]]);
    // A response whose header API explodes still gets its writeHead through.
    const broken: any = {
      headersSent: false,
      hasHeader: () => {
        throw new Error("boom");
      },
      writeHead: (...a: unknown[]) => calls.push(a),
    };
    hookWriteHead(makeTrace([]), broken, 0);
    expect(() => broken.writeHead(201)).not.toThrow();
    expect(calls).toEqual([[200], [201]]);
  });
});

/* ------------------------------------------------------- real http server */

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("hookWriteHead on a real response", () => {
  const trace = makeTrace([], { id: "tr_hook" });
  const t0 = performance.timeOrigin + performance.now();

  async function headersFor(handler: (res: http.ServerResponse) => void) {
    const srv = await listen((_req, res) => {
      hookWriteHead(trace, res, t0);
      handler(res);
    });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/`);
      await r.text();
      return r.headers;
    } finally {
      await srv.close();
    }
  }

  test("adds the trace id and our entries when nothing set Server-Timing", async () => {
    const h = await headersFor((res) => res.end("ok"));
    expect(h.get("x-hoplens-trace")).toBe("tr_hook");
    expect(h.get("server-timing")).toMatch(/^total;desc="Hoplens: to headers";dur=\d/);
  });

  test("appends to a Server-Timing set with setHeader", async () => {
    const h = await headersFor((res) => {
      res.setHeader("Server-Timing", "app;dur=3");
      res.end("ok");
    });
    expect(h.get("server-timing")).toMatch(/^app;dur=3, total;/);
  });

  test("appends to a Server-Timing passed to writeHead (object form)", async () => {
    const h = await headersFor((res) => {
      res.setHeader("Server-Timing", "lost;dur=9"); // writeHead's own headers win in Node
      res.writeHead(200, "OK", { "Server-Timing": "app;dur=4", "content-type": "text/plain" });
      res.end("ok");
    });
    expect(h.get("server-timing")).toMatch(/^app;dur=4, total;/);
    expect(h.get("content-type")).toBe("text/plain");
  });

  test("appends to a Server-Timing passed to writeHead (flat array form)", async () => {
    const h = await headersFor((res) => {
      res.writeHead(200, ["content-type", "text/plain", "server-timing", "app;dur=5"]);
      res.end("ok");
    });
    expect(h.get("server-timing")).toMatch(/^app;dur=5, total;/);
  });

  test("keeps an existing multi-value Server-Timing", async () => {
    const h = await headersFor((res) => {
      res.setHeader("Server-Timing", ["a;dur=1", "b;dur=2"]);
      res.end("ok");
    });
    expect(h.get("server-timing")).toMatch(/^a;dur=1, b;dur=2, total;/);
  });

  test("does not overwrite an x-hoplens-trace the app set", async () => {
    const h = await headersFor((res) => {
      res.setHeader("x-hoplens-trace", "mine");
      res.end("ok");
    });
    expect(h.get("x-hoplens-trace")).toBe("mine");
  });

  test("streamed response: values are what was known at the first flush", async () => {
    const h = await headersFor((res) => {
      res.write("chunk"); // implicit header flush goes through writeHead
      setTimeout(() => res.end("rest"), 30);
    });
    const total = Number(/total;[^,]*dur=([\d.]+)/.exec(h.get("server-timing") ?? "")?.[1]);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(h.get("x-hoplens-trace")).toBe("tr_hook");
  });
});

/* -------------------------------------------- through the real emit hook */

describe("installHttpHook: dev adds headers, production adds nothing", () => {
  const store = new TraceStore(50);
  const rt: any = {
    options: { lateSpanGraceMs: 0 },
    redactor: makeRedactor([]),
    store,
    root: process.cwd(),
    routeInfo: () => undefined,
    proxyFile: () => undefined,
    handleUi: (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("ui"),
  };
  let srv: { port: number; close: () => Promise<void> };
  let sawPatchedWriteHead: boolean | undefined;
  const prevEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    installHttpHook(rt);
    srv = await listen((_req, res) => {
      sawPatchedWriteHead = res.writeHead !== http.ServerResponse.prototype.writeHead;
      res.setHeader("server-timing", "app;dur=1");
      res.end("hello");
    });
  });
  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
    rt.options = { lateSpanGraceMs: 0 };
  });
  afterAll(async () => {
    await srv.close();
  });

  const get = async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/hello`);
    await r.text();
    return r.headers;
  };

  test("dev: x-hoplens-trace names the stored trace; Server-Timing appended", async () => {
    process.env.NODE_ENV = "development";
    const h = await get();
    const id = h.get("x-hoplens-trace");
    expect(id).toMatch(/^tr_/);
    expect(store.get(id!)).toBeDefined();
    expect(h.get("server-timing")).toMatch(/^app;dur=1, total;desc="Hoplens: to headers";dur=/);
    expect(sawPatchedWriteHead).toBe(true);
  });

  test("production: no headers, writeHead left untouched (zero cost)", async () => {
    process.env.NODE_ENV = "production";
    const h = await get();
    expect(h.get("x-hoplens-trace")).toBeNull();
    expect(h.get("server-timing")).toBe("app;dur=1");
    expect(sawPatchedWriteHead).toBe(false);
  });

  test("serverTiming: false: no headers, writeHead untouched", async () => {
    process.env.NODE_ENV = "development";
    rt.options = { lateSpanGraceMs: 0, serverTiming: false };
    const h = await get();
    expect(h.get("x-hoplens-trace")).toBeNull();
    expect(h.get("server-timing")).toBe("app;dur=1");
    expect(sawPatchedWriteHead).toBe(false);
  });
});
