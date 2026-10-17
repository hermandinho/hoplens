// Opt-in core seams for non-Next adapters: HttpTap.describe / requestBody in finalize(), epochs
// mode "none", options.stateDir and RuntimeConfig.framework in /api/meta. Next passes none of them.
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { finalize } from "../src/capture";
import { nullProbe } from "../src/epoch";
import { persistDir } from "../src/persist";
import { Runtime, type RuntimeConfig } from "../src/runtime";
import { makeRedactor } from "../src/serialize";
import type { HttpTap, TraceRecord } from "../src/types";
import { makeTrace, span } from "./helpers";

const req = {} as http.IncomingMessage;
const res = {} as http.ServerResponse;

function fakeRt(httpTap: HttpTap | undefined, routes: Record<string, { file: string; line: number }> = {}): any {
  return {
    options: {},
    redactor: makeRedactor(["password"]),
    httpTap,
    routeInfo: (route: string) => routes[route],
    proxyFile: () => undefined,
  };
}

function bare(extra: Partial<TraceRecord> = {}): TraceRecord {
  return makeTrace([span({ kind: "request", name: "POST /api/orders/7", start: 0, end: 10 })], {
    route: undefined,
    kind: "other",
    method: "POST",
    path: "/api/orders/7",
    url: "/api/orders/7",
    ...extra,
  });
}

const input = (extra: object = {}) => ({ reqBytes: 0, resBytes: 0, req, res, ...extra });

describe("finalize: HttpTap.describe", () => {
  test("sets route and kind, keeps a trailing /route, and resolves the route file as for Next", () => {
    const calls: unknown[][] = [];
    const tap: HttpTap = {
      internalPrefixes: [],
      describe: (...args) => {
        calls.push(args);
        return { route: "/api/orders/:id/route", kind: "route" };
      },
    };
    const t = bare();
    const handler = span({ kind: "handler", name: "handler", start: 1, end: 9 });
    t.spans.push(handler);
    finalize(fakeRt(tap, { "/api/orders/:id/route": { file: "src/orders.ts", line: 12 } }), t, input());
    expect(calls).toEqual([[req, res]]);
    expect(t.route).toBe("/api/orders/:id/route");
    expect(t.kind).toBe("route");
    expect(t.routeFile).toBe("src/orders.ts");
    expect(handler.location).toEqual({ file: "src/orders.ts", line: 12 });
  });

  test("not called when a span carries next.route; Next's /route strip still applies", () => {
    let called = false;
    const tap: HttpTap = {
      internalPrefixes: [],
      describe: () => {
        called = true;
        return { route: "/adapter" };
      },
    };
    const t = bare();
    t.spans[0]!.attrs["next.route"] = "/api/orders/[id]/route";
    finalize(fakeRt(tap), t, input());
    expect(called).toBe(false);
    expect(t.route).toBe("/api/orders/[id]");
  });

  test("kind without a route is ignored; a throwing describe leaves the trace as it was", () => {
    const kindOnly = bare();
    finalize(fakeRt({ internalPrefixes: [], describe: () => ({ kind: "page" }) }), kindOnly, input());
    expect(kindOnly.kind).toBe("other");
    expect(kindOnly.route).toBeUndefined();

    const threw = bare();
    const tap: HttpTap = {
      internalPrefixes: [],
      describe: () => {
        throw new Error("boom");
      },
    };
    expect(() => finalize(fakeRt(tap), threw, input())).not.toThrow();
    expect(threw.route).toBeUndefined();
    expect(threw.facts).toBeDefined();
  });

  test("no tap (Next today): route stays unset without next.route", () => {
    const t = bare();
    finalize(fakeRt(undefined), t, input());
    expect(t.route).toBeUndefined();
    expect(t.kind).toBe("other");
  });
});

describe("finalize: HttpTap.requestBody", () => {
  const withBody = (value: unknown, contentType?: string) => {
    const t = bare();
    const tap: HttpTap = { internalPrefixes: [], requestBody: () => ({ contentType, value }) };
    const inp = input();
    finalize(fakeRt(tap), t, inp);
    return { t, inp };
  };

  test("a parsed JSON body is redacted through preview() and sized", () => {
    const { t, inp } = withBody({ user: "ada", password: "hunter2" }, "application/json");
    expect(t.request.body?.contentType).toBe("application/json");
    expect(t.request.body?.json).toEqual({ user: "ada", password: "[redacted]" });
    expect(t.request.body?.size).toBe(Buffer.byteLength(JSON.stringify({ user: "ada", password: "hunter2" })));
    // No content-length was seen: the parsed size feeds the reqBytes fact.
    expect(inp.reqBytes).toBe(t.request.body?.size);
    expect(t.facts?.reqBytes).toBe(t.request.body?.size);
  });

  test("strings are text, buffers binary, undefined is no body", () => {
    expect(withBody("a=1", "text/plain").t.request.body).toMatchObject({ text: "a=1", size: 3 });
    expect(withBody(Buffer.from([1, 2, 3])).t.request.body).toEqual({
      contentType: undefined,
      size: 3,
      binary: true,
    });
    expect(withBody(undefined).t.request.body).toBeUndefined();
  });

  test("not called when a body was already captured; a content-length wins for reqBytes", () => {
    let called = false;
    const tap: HttpTap = {
      internalPrefixes: [],
      requestBody: () => {
        called = true;
        return { value: { x: 1 } };
      },
    };
    const t = bare({ request: { headers: {}, body: { size: 2, json: {} } } });
    finalize(fakeRt(tap), t, input());
    expect(called).toBe(false);
    expect(t.request.body).toEqual({ size: 2, json: {} });

    const sized = bare();
    const inp = input({ reqBytes: 900 });
    finalize(fakeRt({ internalPrefixes: [], requestBody: () => ({ value: { x: 1 } }) }), sized, inp);
    expect(inp.reqBytes).toBe(900);
  });

  test("a throwing requestBody is swallowed", () => {
    const t = bare();
    const tap: HttpTap = {
      internalPrefixes: [],
      requestBody: () => {
        throw new Error("boom");
      },
    };
    expect(() => finalize(fakeRt(tap), t, input())).not.toThrow();
    expect(t.request.body).toBeUndefined();
  });
});

describe("persistDir: options.stateDir", () => {
  test("unset: <distDir>/cache/hoplens as before", () => {
    expect(persistDir("/p", ".next")).toBe(path.join("/p", ".next", "cache", "hoplens"));
    expect(persistDir("/p", ".next", undefined)).toBe(path.join("/p", ".next", "cache", "hoplens"));
  });
  test("set: used as the dir, resolved against root", () => {
    expect(persistDir("/p", "", ".hoplens")).toBe(path.resolve("/p", ".hoplens"));
    const abs = path.resolve("/state/x");
    expect(persistDir("/p", ".next", abs)).toBe(abs);
  });
});

describe("Runtime: epochs mode and framework meta", () => {
  const runtimes: Runtime[] = [];
  const servers: http.Server[] = [];
  const make = (extra: Partial<RuntimeConfig>, distDir = ".next-none") => {
    const rt = new Runtime({
      options: { port: 0, basePath: "", distDir, root: process.cwd() },
      discovery: { scan: () => ({ routes: [], typescript: false, scannedAt: 0 }) },
      ...extra,
    });
    runtimes.push(rt);
    return rt;
  };
  afterAll(async () => {
    for (const rt of runtimes) rt.stop();
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  const meta = async (rt: Runtime) => {
    const server = http.createServer((req, res) => rt.handleUi(req, res));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/__hoplens/api/meta`);
    return (await r.json()) as Record<string, unknown>;
  };

  test("mode none: a null probe, no source watcher, no chunk index, epoch 0 forever", () => {
    const rt = make({ epochs: { mode: "none" } }, "");
    const e = rt.epochs as any;
    expect(e.probe).toBe(nullProbe);
    expect(e.sources).toBeUndefined();
    expect(e.chunks).toBeUndefined();
    expect(rt.epochs.observe("GET /a", true)).toEqual({ epoch: 0, firstInEpoch: true });
    expect(rt.epochs.observe("GET /a", false)).toEqual({ epoch: 0, firstInEpoch: false });
  });

  test("default (build): the build-output probe, as before", () => {
    const e = make({}).epochs as any;
    expect(e.probe).not.toBe(nullProbe);
    expect(make({ epochs: { mode: "build" } }).epochs as any).not.toHaveProperty("probe", nullProbe);
  });

  test("framework is reported; a non-Next framework skips the next/package.json lookup", async () => {
    const plain = await meta(make({}));
    expect(plain.framework).toBeUndefined();
    const next = await meta(make({ framework: { name: "next", version: "16.0.0" } }));
    expect(next.framework).toEqual({ name: "next", version: "16.0.0" });
    expect(next.next).toBe(plain.next);
    const express = await meta(make({ framework: { name: "express", version: "5.1.0" } }));
    expect(express.framework).toEqual({ name: "express", version: "5.1.0" });
    expect(express.next).toBeUndefined();
  });
});
