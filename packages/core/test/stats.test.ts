import { describe, expect, test } from "vitest";
import {
  HIST_BUCKETS,
  LogHistogram,
  RouteStatsStore,
  bucketHigh,
  bucketIndex,
  bucketLow,
  isErrorTrace,
  routeKeyOf,
} from "../src/stats";
import type { Finding, TraceFacts, TraceRecord } from "../src/types";
import { makeTrace } from "./helpers";

function facts(over: Partial<TraceFacts> = {}): TraceFacts {
  return {
    time: { db: 10, cache: 0, ext: 20, fn: 5, framework: 3, compile: 0, idle: 2 },
    reqBytes: 0,
    resBytes: 0,
    counts: { spans: 5, db: 2, fetch: 1, cache: 0, fn: 1, warn: 0, error: 0 },
    cold: false,
    compileMs: 0,
    droppedSpans: 0,
    epoch: 0,
    ...over,
  };
}

let seq = 0;
function trace(duration: number, over: Partial<TraceRecord> = {}, f: Partial<TraceFacts> = {}): TraceRecord {
  return makeTrace([], { id: `t${++seq}`, startedAt: 1000 + seq, duration, facts: facts(f), ...over });
}

describe("log histogram bucket math", () => {
  test("bounds are contiguous and grow by 2^(1/4)", () => {
    expect(bucketLow(0)).toBe(0);
    expect(bucketHigh(0)).toBeCloseTo(0.1);
    for (let i = 1; i < HIST_BUCKETS - 1; i++) {
      expect(bucketLow(i)).toBeCloseTo(bucketHigh(i - 1), 10);
      expect(bucketHigh(i) / bucketLow(i)).toBeCloseTo(2 ** 0.25, 10);
    }
    expect(bucketHigh(HIST_BUCKETS - 1)).toBe(Number.POSITIVE_INFINITY);
  });

  test("every value lands in the bucket whose bounds contain it", () => {
    const values = [0, 0.05, 0.1, 0.11, 1, 1.19, 2, 10, 99.9, 100, 250, 1000, 5000, 60_000, 599_000];
    for (let i = 1; i < HIST_BUCKETS - 1; i++) values.push(bucketLow(i), bucketHigh(i) - 1e-9);
    for (const v of values) {
      const i = bucketIndex(v);
      expect(v, `value ${v} -> bucket ${i}`).toBeGreaterThanOrEqual(bucketLow(i));
      expect(v, `value ${v} -> bucket ${i}`).toBeLessThan(bucketHigh(i));
    }
  });

  test("out-of-range and junk values are clamped, never thrown", () => {
    expect(bucketIndex(-5)).toBe(0);
    expect(bucketIndex(Number.NaN)).toBe(0);
    expect(bucketIndex(1e12)).toBe(HIST_BUCKETS - 1);
    const h = new LogHistogram();
    h.add(Number.NaN);
    h.add(Number.POSITIVE_INFINITY);
    expect(h.n).toBe(0);
    h.add(-3);
    expect(h.n).toBe(1);
    expect(h.min).toBe(0);
  });
});

describe("quantiles", () => {
  test("empty -> undefined; single / identical samples come back exactly", () => {
    const h = new LogHistogram();
    expect(h.quantile(0.5)).toBeUndefined();
    h.add(123.4);
    expect(h.quantile(0)).toBe(123.4);
    expect(h.quantile(0.5)).toBe(123.4);
    expect(h.quantile(1)).toBe(123.4);
    for (let i = 0; i < 50; i++) h.add(123.4);
    expect(h.quantile(0.95)).toBe(123.4);
  });

  test("uniform 1..1000 ms: p50/p95/p99 within one bucket (~19%) of the exact value", () => {
    const h = new LogHistogram();
    for (let i = 1; i <= 1000; i++) h.add(i);
    for (const [q, exact] of [
      [0.5, 500],
      [0.95, 950],
      [0.99, 990],
    ] as const) {
      const v = h.quantile(q)!;
      expect(Math.abs(v - exact) / exact, `q${q} = ${v}`).toBeLessThan(0.19);
    }
    expect(h.quantile(1)).toBe(1000);
    expect(h.quantile(0)).toBe(1);
    expect(h.mean()).toBeCloseTo(500.5);
  });

  test("bimodal: p50 sits in the fast mode, p95 in the slow one", () => {
    const h = new LogHistogram();
    for (let i = 0; i < 90; i++) h.add(10);
    for (let i = 0; i < 10; i++) h.add(800);
    expect(h.quantile(0.5)).toBeCloseTo(10, 0);
    expect(h.quantile(0.95)!).toBeGreaterThan(700);
  });

  test("merge equals adding everything to one histogram", () => {
    const a = new LogHistogram();
    const b = new LogHistogram();
    const all = new LogHistogram();
    for (let i = 0; i < 200; i++) {
      const v = (i * 37) % 500;
      (i % 2 ? a : b).add(v);
      all.add(v);
    }
    a.merge(b);
    expect(Array.from(a.counts)).toEqual(Array.from(all.counts));
    expect(a.quantile(0.95)).toBe(all.quantile(0.95));
    expect(a.n).toBe(all.n);
    expect(a.min).toBe(all.min);
    expect(a.max).toBe(all.max);
  });

  test("buckets() lists non-empty buckets only, last one open-ended", () => {
    const h = new LogHistogram();
    h.add(1);
    h.add(1);
    h.add(1e9);
    const b = h.buckets();
    expect(b).toHaveLength(2);
    expect(b[0]!.count).toBe(2);
    expect(b[1]!.hi).toBeNull();
  });
});

describe("RouteStatsStore", () => {
  test("aggregates per route + epoch: count, errors, cold excluded from quantiles, averages", () => {
    const s = new RouteStatsStore();
    s.add(trace(3000, {}, { cold: true, compileMs: 2900, time: { ...facts().time, compile: 2900 } }));
    for (let i = 1; i <= 20; i++) s.add(trace(i * 10));
    s.add(trace(50, { status: 503 }));
    s.add(trace(50, { status: 404 }));
    s.add(trace(50, { status: undefined, error: { type: "Error", message: "x", stack: "" } }));
    const snap = s.snapshot();
    expect(snap.routes).toHaveLength(1);
    const r = snap.routes[0]!;
    expect(r.key).toBe("GET /api/products");
    expect(r.current.count).toBe(24);
    expect(r.current.errors).toBe(2); // 503 + error-without-status; a 404 is not an error
    expect(r.current.cold).toBe(1);
    expect(r.current.warm).toBe(23);
    expect(r.current.max).toBe(200); // the 3000ms cold request is not in the warm histogram
    expect(r.current.p50).toBeGreaterThan(40);
    expect(r.current.p50).toBeLessThan(120);
    expect(r.current.time?.db).toBe(10);
    expect(r.current.time?.compile).toBe(0); // cold excluded from the time averages too
    expect(r.current.io).toEqual({ db: 2, fetch: 1, cache: 0, fn: 1 });
    expect(r.current.buckets).toBeUndefined();
    expect(s.snapshot({ buckets: true }).routes[0]!.current.buckets!.length).toBeGreaterThan(0);
    expect(snap.totals).toMatchObject({ requests: 24, errors: 2, cold: 1, routes: 1 });
  });

  test("route key = method + template, else normalized path", () => {
    expect(routeKeyOf({ method: "GET", route: "/api/x/[id]", path: "/api/x/1" })).toBe("GET /api/x/[id]");
    expect(routeKeyOf({ method: "GET", path: "/api/x/123" })).toBe("GET /api/x/:id");
    const s = new RouteStatsStore();
    s.add(trace(10, { route: undefined, path: "/u/1" }));
    s.add(trace(10, { route: undefined, path: "/u/2" }));
    s.add(trace(10, { method: "POST", route: undefined, path: "/u/2" }));
    expect(
      s
        .snapshot()
        .routes.map((r) => r.key)
        .sort(),
    ).toEqual(["GET /u/:id", "POST /u/:id"]);
  });

  test("isErrorTrace matches the UI: 5xx, or an error without status", () => {
    expect(isErrorTrace({ status: 500 })).toBe(true);
    expect(isErrorTrace({ status: 200, error: { type: "E", message: "", stack: "" } })).toBe(false);
    expect(isErrorTrace({ status: undefined, error: { type: "E", message: "", stack: "" } })).toBe(true);
    expect(isErrorTrace({ status: 404 })).toBe(false);
  });

  test("epochs: newest first, capped, merged in `all`", () => {
    const s = new RouteStatsStore({ maxEpochs: 3 });
    for (let e = 0; e < 5; e++) for (let i = 0; i < 2; i++) s.add(trace(10 * (e + 1), {}, { epoch: e }));
    const r = s.snapshot().routes[0]!;
    expect(r.epochs.map((e) => e.epoch)).toEqual([4, 3, 2]);
    expect(r.current.epoch).toBe(4);
    expect(r.current.p50).toBe(50);
    expect(r.all.epoch).toBe(-1);
    expect(r.all.count).toBe(6);
    expect(s.snapshot().epoch).toBe(4);
    // A straggler from an epoch older than every kept one is not counted.
    s.add(trace(10, {}, { epoch: 0 }));
    expect(s.snapshot().routes[0]!.all.count).toBe(6);
  });

  test("routes capped, least recently seen dropped", () => {
    const s = new RouteStatsStore({ maxRoutes: 3 });
    for (const p of ["/a", "/b", "/c"]) s.add(trace(1, { route: p }));
    s.add(trace(1, { route: "/a" })); // touch /a
    s.add(trace(1, { route: "/d" }));
    expect(
      s
        .snapshot()
        .routes.map((r) => r.route)
        .sort(),
    ).toEqual(["/a", "/c", "/d"]);
    expect(s.size).toBe(3);
  });

  test("finding fingerprints counted per request, capped", () => {
    const f = (fp: string): Finding => ({
      rule: "n-plus-1",
      severity: "warn",
      title: `t ${fp}`,
      fingerprint: fp,
      spanIds: [],
    });
    const s = new RouteStatsStore({ maxFindings: 2 });
    s.add(trace(1, { findings: [f("a"), f("b")] }));
    s.add(trace(1, { findings: [f("a"), f("c")] }));
    const fs = s.snapshot().routes[0]!.current.findings;
    expect(fs.map((x) => [x.fingerprint, x.count])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  test("traces without facts still count (epoch 0, warm)", () => {
    const s = new RouteStatsStore();
    s.add(makeTrace([], { id: "nofacts", duration: 7 }));
    const r = s.snapshot().routes[0]!;
    expect(r.current).toMatchObject({ count: 1, warm: 1, p50: 7 });
    expect(r.current.time).toBeUndefined();
    expect(r.current.io).toBeUndefined();
  });

  test("clear() resets everything and moves `since`", () => {
    let now = 100;
    const s = new RouteStatsStore({}, () => now);
    s.add(trace(5));
    s.noteLateSpan();
    expect(s.snapshot().totals.droppedSpans).toBe(1);
    now = 200;
    s.clear();
    const snap = s.snapshot();
    expect(snap).toMatchObject({ routes: [], since: 200, epoch: 0 });
    expect(snap.totals).toEqual({ requests: 0, errors: 0, cold: 0, routes: 0, droppedSpans: 0 });
  });

  test("a malformed trace never throws", () => {
    const s = new RouteStatsStore();
    expect(() => s.add({ method: "GET" } as unknown as TraceRecord)).not.toThrow();
    expect(() => s.add(trace(1, { facts: { epoch: 0 } as unknown as TraceFacts }))).not.toThrow();
  });

  test("memory stays bounded under churn", () => {
    const s = new RouteStatsStore({ maxRoutes: 50, maxEpochs: 5 });
    for (let i = 0; i < 20_000; i++) s.add(trace(i % 300, { route: `/r${i % 500}` }, { epoch: i % 13 }));
    const snap = s.snapshot();
    expect(snap.routes.length).toBe(50);
    for (const r of snap.routes) expect(r.epochs.length).toBeLessThanOrEqual(5);
  });
});
