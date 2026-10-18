// Ctx.req/res from the emit tap, Runtime.currentTrace() and Runtime.beginHop() through the real http
// hook and OTel processor. Own file: installHttpHook and installOtel patch globals for the worker.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { als, installHttpHook, installOtel } from "../src/capture";
import { Runtime } from "../src/runtime";
import { makeRedactor } from "../src/serialize";
import { TraceStore } from "../src/store";
import type { TraceRecord } from "../src/types";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

describe("adapter seams over the http tap", () => {
  const store = new TraceStore(50);
  const rt: any = {
    options: { lateSpanGraceMs: 5, serverTiming: false },
    redactor: makeRedactor([]),
    store,
    root: process.cwd(),
    httpTap: {
      internalPrefixes: [],
      describe: (req: http.IncomingMessage) => ({ route: (req as any).routeTemplate, kind: "route" }),
    },
    routeInfo: () => undefined,
    proxyFile: () => undefined,
    handleUi: (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("ui"),
  };
  // Runtime's methods are thin over als / beginHop; borrowed so this fake runtime has them.
  const currentTrace = Runtime.prototype.currentTrace;
  const beginHop = Runtime.prototype.beginHop;
  let handler: Handler = (_req, res) => res.end();
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    installOtel(rt);
    installHttpHook(rt);
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const hit = async (p = "/api/orders/7") => {
    const done = new Promise<TraceRecord>((resolve) => store.once("done", resolve));
    const r = await fetch(`http://127.0.0.1:${port}${p}`);
    await r.text();
    return done;
  };

  test("the context carries the request and response; describe() gets them in finalize", async () => {
    let same = false;
    handler = (req, res) => {
      const ctx = als.getStore();
      same = ctx?.req === req && ctx?.res === res;
      (req as any).routeTemplate = "/api/orders/:id";
      res.end("ok");
    };
    const t = await hit();
    expect(same).toBe(true);
    expect(t.route).toBe("/api/orders/:id");
    expect(t.kind).toBe("route");
  });

  test("currentTrace() is the request's trace inside it and undefined outside", async () => {
    let seen: TraceRecord | undefined;
    handler = (_req, res) => {
      seen = currentTrace.call(rt);
      res.end();
    };
    const t = await hit();
    expect(seen).toBe(t);
    expect(currentTrace.call(rt)).toBeUndefined();
    expect(beginHop.call(rt, "function", { name: "outside" })).toBeUndefined();
  });

  test("beginHop: kind and location recorded, run() nests children, end() is idempotent", async () => {
    handler = (_req, res) => {
      const mw = beginHop.call(rt, "handler", { name: "jsonParser", file: "src/app.ts", line: 14 })!;
      const inner = mw.run(() => beginHop.call(rt, "function", { name: "loadUser" }));
      // A callback that lost the context still lands in this request through run().
      setTimeout(() => {
        mw.run(() => {
          inner?.end();
          mw.end();
          mw.end(new Error("ignored: already ended"));
          res.end();
        });
      }, 1);
    };
    const t = await hit();
    const mw = t.spans.find((s) => s.name === "jsonParser");
    const inner = t.spans.find((s) => s.name === "loadUser");
    expect(mw?.kind).toBe("handler");
    expect(mw?.location).toEqual({ file: "src/app.ts", line: 14 });
    expect(mw?.error).toBeUndefined();
    expect(inner?.kind).toBe("function");
    expect(inner?.parentId).toBe(mw?.id);
    expect(inner?.location).toBeUndefined();
    expect(t.spans.filter((s) => s.name === "jsonParser")).toHaveLength(1);
  });

  test("exit(): work handed off from inside a hop runs as its sibling, not its child", async () => {
    handler = (_req, res) => {
      const outer = beginHop.call(rt, "custom", { name: "outer" })!;
      outer.run(() => {
        const h = beginHop.call(rt, "handler", { name: "GET /a" })!;
        h.run(() => {
          // Express's next(): called from inside the handler, continues the parent's chain.
          h.end();
          h.exit(() => {
            beginHop.call(rt, "handler", { name: "GET /b" })!.end();
            outer.end();
            res.end();
          });
        });
      });
    };
    const t = await hit();
    const outer = t.spans.find((s) => s.name === "outer");
    const a = t.spans.find((s) => s.name === "GET /a");
    const b = t.spans.find((s) => s.name === "GET /b");
    expect(outer).toBeDefined();
    expect(a?.parentId).toBe(outer?.id);
    expect(b?.parentId).toBe(outer?.id);
  });

  test("bindRequestEmitter: a hop opened from a late 'end' nests under the hop that registered it", async () => {
    rt.httpTap.bindRequestEmitter = true;
    let kept: any;
    handler = (req, res) => {
      kept = als.getStore();
      const mw = beginHop.call(rt, "custom", { name: "express.json" })!;
      mw.run(() => {
        req.on("data", () => {});
        req.on("end", () => {
          const h = beginHop.call(rt, "handler", { name: "POST /api/orders" })!;
          h.end();
          mw.end();
          res.end();
        });
      });
    };
    try {
      const done = new Promise<TraceRecord>((resolve) => store.once("done", resolve));
      // The 2nd chunk lands on a later tick, after mw.run() has returned.
      await new Promise<void>((resolve, reject) => {
        const r = http.request({ port, host: "127.0.0.1", method: "POST", path: "/api/orders" }, (x) => {
          x.resume();
          x.on("end", resolve);
        });
        r.on("error", reject);
        r.write('{"a":');
        setTimeout(() => r.end("1}"), 50);
      });
      const t = await done;
      const mw = t.spans.find((s) => s.name === "express.json");
      const h = t.spans.find((s) => s.name === "POST /api/orders");
      expect(mw).toBeDefined();
      expect(h?.parentId).toBe(mw?.id);
      // Once final, the context lets go of the request, the response and the hop context.
      expect(kept.req).toBeUndefined();
      expect(kept.res).toBeUndefined();
      expect(kept.otel).toBeUndefined();
    } finally {
      rt.httpTap.bindRequestEmitter = undefined;
    }
  });

  test("end(err) marks the hop failed like a throwing wrapped function; end(null) does not", async () => {
    handler = (_req, res) => {
      beginHop.call(rt, "function", { name: "failing" })!.end(new TypeError("nope"));
      beginHop.call(rt, "function", { name: "thrownValue" })!.end("bad");
      beginHop.call(rt, "function", { name: "nextNull" })!.end(null);
      res.end();
    };
    const t = await hit();
    const failing = t.spans.find((s) => s.name === "failing");
    expect(failing?.error).toMatchObject({ type: "TypeError", message: "nope" });
    expect(t.spans.find((s) => s.name === "thrownValue")?.error).toMatchObject({ type: "Thrown", message: "bad" });
    expect(t.spans.find((s) => s.name === "nextNull")?.error).toBeUndefined();
    expect(t.error?.message).toBeDefined();
  });

  test("a body over the capture limit written in one chunk keeps its first bytes (res.json of a big export)", async () => {
    const body = JSON.stringify({ rows: Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `row ${i}` })) });
    expect(body.length).toBeGreaterThan(512 * 1024);
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(body);
    };
    const t = await hit("/api/report");
    expect(t.response.body).toMatchObject({ truncated: true, size: Buffer.byteLength(body) });
    // Cut JSON doesn't parse: it is shown as text, starting with the response's own first bytes.
    expect(t.response.body?.text?.startsWith('{"rows":[{"id":0,"name":"row 0"}')).toBe(true);
  });
});
