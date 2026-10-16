// Late-span `update` events (store throttle + the real OTel processor path) and the Phase 2 HTTP API:
// GET /api/traces?q=, /api/stats, /api/queries, and the SSE `update` event.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { trace as otelTrace } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { als, installOtel } from "../src/capture";
import { Runtime } from "../src/runtime";
import { recordTarget } from "../src/server";
import { TraceStore, UPDATE_THROTTLE_MS } from "../src/store";
import type { TraceRecord } from "../src/types";
import { db, makeTrace, skeleton } from "./helpers";

function bare(id: string, extra: Partial<TraceRecord> = {}): TraceRecord {
  return makeTrace([], { id, done: false, ...extra });
}

/* ------------------------------------------------------- update throttle */

describe("TraceStore.update throttle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("leading emit, then at most one per window per trace (trailing edge included)", () => {
    vi.useFakeTimers();
    const store = new TraceStore(10);
    const seen: string[] = [];
    store.on("update", (t) => seen.push(t.id));
    const a = bare("a");
    const b = bare("b");
    store.add(a, { rawHeaders: {} });
    store.add(b, { rawHeaders: {} });
    store.update(a); // in flight: ignored
    expect(seen).toEqual([]);
    store.finish(a);
    store.finish(b);
    store.update(a);
    expect(seen).toEqual(["a"]); // leading edge
    store.update(a);
    store.update(a);
    store.update(b); // per trace: b isn't throttled by a
    expect(seen).toEqual(["a", "b"]);
    vi.advanceTimersByTime(UPDATE_THROTTLE_MS - 1);
    expect(seen).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["a", "b", "a"]); // one trailing emit for the two coalesced calls
    vi.advanceTimersByTime(UPDATE_THROTTLE_MS * 4);
    expect(seen).toEqual(["a", "b", "a"]);
    store.update(a); // window long over: immediate again
    expect(seen).toEqual(["a", "b", "a", "a"]);
  });

  test("cleared or evicted traces never emit, pending timers are dropped", () => {
    vi.useFakeTimers();
    const store = new TraceStore(1);
    const seen: string[] = [];
    store.on("update", (t) => seen.push(t.id));
    const a = bare("a");
    store.add(a, { rawHeaders: {} });
    store.finish(a);
    store.update(a);
    store.update(a); // pending trailing
    store.add(bare("b"), { rawHeaders: {} }); // evicts a
    vi.advanceTimersByTime(UPDATE_THROTTLE_MS * 2);
    expect(seen).toEqual(["a"]);
    store.update(a);
    expect(seen).toEqual(["a"]);

    const c = bare("c");
    store.add(c, { rawHeaders: {} });
    store.finish(c);
    store.update(c);
    store.update(c);
    store.clear();
    vi.advanceTimersByTime(UPDATE_THROTTLE_MS * 2);
    expect(seen).toEqual(["a", "c"]);
  });
});

/* ------------------------------------------ late span through the processor */

describe("late span via the OTel processor", () => {
  test("a span ending after done is appended (hoplens.late), counted, and announced with `update`", async () => {
    const store = new TraceStore(10);
    const noted: number[] = [];
    const rt: any = {
      root: process.cwd(),
      redactor: (v: unknown) => v,
      store,
      stats: { noteLateSpan: () => noted.push(1) },
    };
    installOtel(rt);
    const tracer = otelTrace.getTracer("t");
    const t = bare("late1");
    store.add(t, { rawHeaders: {} });
    const ctx = { trace: t, t0: performance.timeOrigin + performance.now() };
    const s = als.run(ctx, () => tracer.startSpan("after()", { attributes: { "hoplens.kind": "function" } }));
    t.facts = {
      time: { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 },
      reqBytes: 0,
      resBytes: 0,
      counts: { spans: 0, db: 0, fetch: 0, cache: 0, fn: 0, warn: 0, error: 0 },
      cold: false,
      compileMs: 0,
      droppedSpans: 0,
      epoch: 0,
    };
    store.finish(t);
    const updates: TraceRecord[] = [];
    store.on("update", (x) => updates.push(x));
    s.end();
    expect(t.spans).toHaveLength(1);
    expect(t.spans[0]!.attrs["hoplens.late"]).toBe(true);
    expect(t.facts.droppedSpans).toBe(1);
    expect(noted).toEqual([1]);
    expect(updates.map((u) => u.id)).toEqual(["late1"]);

    // A late span for a trace cleared before it landed is not counted into (just-reset) stats.
    const t2 = bare("late2");
    store.add(t2, { rawHeaders: {} });
    const ctx2 = { trace: t2, t0: performance.timeOrigin + performance.now() };
    const s2 = als.run(ctx2, () => tracer.startSpan("after2()", { attributes: { "hoplens.kind": "function" } }));
    store.finish(t2);
    store.clear();
    s2.end();
    expect(noted).toEqual([1]);
    expect(updates.map((u) => u.id)).toEqual(["late1"]);
  });
});

/* ------------------------------------------------------------- HTTP API */

describe("Phase 2 API", () => {
  let rt: Runtime;
  let port: number;
  let server: http.Server;

  const seed = (id: string, over: Partial<TraceRecord>, n = 0) => {
    const { root, handler, fn } = skeleton(100);
    const spans = [root, handler, fn];
    for (let i = 0; i < n; i++) spans.push(db(fn.id, 5 + i * 5, 9 + i * 5, `SELECT * FROM t WHERE id = ${i}`));
    const t = makeTrace(spans, { id, done: false, startedAt: Date.now(), ...over });
    rt.store.add(t, { rawHeaders: {} });
    t.facts = {
      time: { db: 4 * n, cache: 0, ext: 0, fn: 10, framework: 0, compile: 0, idle: 0 },
      reqBytes: 0,
      resBytes: 0,
      counts: { spans: spans.length, db: n, fetch: 0, cache: 0, fn: 1, warn: 0, error: 0 },
      cold: false,
      compileMs: 0,
      droppedSpans: 0,
      epoch: 0,
    };
    rt.store.finish(t);
    return t;
  };

  beforeAll(async () => {
    rt = new Runtime({
      options: { port: 0, basePath: "", distDir: ".next-none", root: process.cwd() },
      discovery: { scan: () => ({ routes: [], typescript: false, scannedAt: 0 }) },
    });
    server = http.createServer((req, res) => rt.handleUi(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;

    seed("t_ok", { status: 200, duration: 40, path: "/api/products", url: "/api/products" }, 6);
    seed("t_slow", { status: 200, duration: 900, path: "/api/products", url: "/api/products?page=2" }, 2);
    seed("t_err", {
      status: 503,
      duration: 300,
      method: "POST",
      path: "/api/pay",
      url: "/api/pay",
      route: "/api/pay",
      error: { type: "UpstreamError", message: "Upstream timeout", stack: "" },
      logs: [{ t: 1, level: "error", text: "retrying payment gateway" }],
      response: { headers: {}, body: { size: 20, json: { code: "GATEWAY_DOWN" } } },
    });
    seed("t_body", {
      status: 200,
      duration: 10,
      path: "/api/echo",
      url: "/api/echo",
      route: "/api/echo",
      request: { headers: {}, body: { size: 10, text: "needle-in-request" } },
    });
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const get = async (p: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/__hoplens${p}`);
    return { status: r.status, headers: r.headers, body: (await r.json()) as any };
  };
  const ids = (body: Array<{ id: string }>) => body.map((t) => t.id);

  test("GET /api/traces without q is unchanged", async () => {
    const r = await get("/api/traces");
    expect(ids(r.body)).toEqual(["t_body", "t_err", "t_slow", "t_ok"]);
  });

  test("GET /api/traces?q= filters with the query language, server-side text includes logs and bodies", async () => {
    const q = async (s: string) => ids((await get(`/api/traces?q=${encodeURIComponent(s)}`)).body);
    expect(await q("status:5xx")).toEqual(["t_err"]);
    expect(await q("dur:>200 method:GET")).toEqual(["t_slow"]);
    expect(await q("route:/api/products")).toEqual(["t_slow", "t_ok"]);
    expect(await q("page")).toEqual(["t_slow"]); // url
    expect(await q("timeout")).toEqual(["t_err"]); // error message
    expect(await q("payment gateway")).toEqual(["t_err"]); // logs
    expect(await q("GATEWAY_DOWN")).toEqual(["t_err"]); // response body
    expect(await q("needle-in-request")).toEqual(["t_body"]); // request body
    expect(await q("-status:2xx")).toEqual(["t_err"]);
    const bad = await get(`/api/traces?q=${encodeURIComponent("status:nope method:POST")}`);
    expect(ids(bad.body)).toEqual(["t_err"]);
    expect(JSON.parse(decodeURIComponent(bad.headers.get("x-hoplens-query-errors")!))).toHaveLength(1);
  });

  test("recordTarget leaves in-flight traces without a status", () => {
    expect(recordTarget(makeTrace([], { done: false, status: 200 })).status).toBeUndefined();
  });

  test("GET /api/stats aggregates per route", async () => {
    const r = await get("/api/stats");
    expect(r.status).toBe(200);
    const products = r.body.routes.find((x: any) => x.key === "GET /api/products");
    expect(products.current).toMatchObject({ count: 2, warm: 2, errors: 0, max: 900 });
    expect(r.body.totals).toMatchObject({ requests: 4, errors: 1, routes: 3 });
    expect(typeof r.body.since).toBe("number");
    expect(products.current.buckets).toBeUndefined();
    expect((await get("/api/stats?buckets=1")).body.routes[0].current.buckets.length).toBeGreaterThan(0);
  });

  test("GET /api/queries aggregates fingerprints with retained trace samples", async () => {
    const r = await get("/api/queries");
    expect(r.body.queries).toHaveLength(1);
    expect(r.body.queries[0]).toMatchObject({
      shape: "SELECT * FROM t WHERE id = ?",
      calls: 8,
      traces: 2,
      traceIds: ["t_slow", "t_ok"],
    });
    expect((await get("/api/queries?kind=fetch")).body.queries).toEqual([]);
    expect(r.body.hosts).toEqual([]);
  });

  test("SSE streams `update` for late changes", async () => {
    const t = rt.store.get("t_ok")!;
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/__hoplens/api/events`, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buf += c;
          if (buf.includes("event: hello")) rt.store.update(t);
          const at = buf.indexOf("event: update");
          if (at >= 0 && buf.indexOf("\n\n", at) > 0) {
            req.destroy();
            resolve(buf.slice(at, buf.indexOf("\n\n", at)));
          }
        });
      });
      req.on("error", reject);
      setTimeout(() => reject(new Error("no update event")), 3000);
    });
    const data = JSON.parse(got.split("\ndata: ")[1]!);
    expect(data).toMatchObject({ id: "t_ok", done: true });
  });

  test("DELETE /api/traces clears stats and queries too", async () => {
    await fetch(`http://127.0.0.1:${port}/__hoplens/api/traces`, { method: "DELETE" });
    expect((await get("/api/stats")).body.routes).toEqual([]);
    expect((await get("/api/queries")).body.queries).toEqual([]);
  });
});
