// WP5: the Overview rollup in RouteStatsStore -- impact-ranked findings with "seen once", the
// errors tally (5xx / thrown / swallowed), per-route exemplars and the per-epoch p50 delta.
import { describe, expect, test } from "vitest";
import {
  type EpochStats,
  type Exemplar,
  RouteStatsStore,
  epochDelta,
  pickExemplars,
  rankFindings,
  rollupFindings,
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
  seq++;
  return makeTrace([], { id: `t${seq}`, startedAt: 1000 + seq, duration, facts: facts(f), ...over });
}

const nplus1 = (saved: number): Finding => ({
  rule: "n-plus-1",
  severity: "warn",
  title: "getPosts fetched GET jsonplaceholder.typicode.com/users/:id x10 via getUser() (N+1)",
  fingerprint: "fp-nplus1",
  spanIds: [],
  fn: "getPosts",
  location: { file: "src/lib/external.ts", line: 63 },
  count: 10,
  estSavedMs: saved,
});

const compileStall: Finding = {
  rule: "cold-compile",
  severity: "error",
  title: "12.5s compiling /api/catalog",
  fingerprint: "fp-compile",
  spanIds: [],
  estSavedMs: 12_500,
};

describe("finding rollup and impact ranking", () => {
  test("a repeatable N+1 outranks a one-request compile stall worth more ms", () => {
    const s = new RouteStatsStore();
    for (let i = 0; i < 9; i++)
      s.add(trace(320, { url: "/api/feed", path: "/api/feed", route: "/api/feed", findings: [nplus1(173)] }));
    s.add(
      trace(12_600, { url: "/api/catalog", path: "/api/catalog", route: "/api/catalog", findings: [compileStall] }),
    );
    const fs = s.snapshot().findings;
    expect(fs.map((f) => f.fingerprint)).toEqual(["fp-nplus1", "fp-compile"]);
    const [n1, stall] = fs;
    expect(n1).toMatchObject({
      requests: 9,
      seenOnce: false,
      savedMsPerRequest: 173,
      impactMs: 1557,
      routes: ["GET /api/feed"],
      fn: "getPosts",
      location: { file: "src/lib/external.ts", line: 63 },
      maxCount: 10,
    });
    expect(n1!.lastTraceId).toMatch(/^t\d+$/);
    expect(stall).toMatchObject({ requests: 1, seenOnce: true, savedMsPerRequest: 12_500, impactMs: 12_500 });
  });

  test("saveable per request is the mean of the estimates; impact scales it by every request", () => {
    const s = new RouteStatsStore();
    s.add(trace(100, { findings: [nplus1(100)] }));
    s.add(trace(100, { findings: [nplus1(200)] }));
    // A request with the finding but no estimate still counts as a request.
    s.add(trace(100, { findings: [{ ...nplus1(0), estSavedMs: undefined }] }));
    const [f] = s.snapshot().findings;
    expect(f).toMatchObject({ requests: 3, savedMsPerRequest: 150, impactMs: 450 });
  });

  test("a fingerprint twice in one trace counts one request, with the larger saving", () => {
    const s = new RouteStatsStore();
    s.add(trace(100, { findings: [nplus1(40), nplus1(90)] }));
    const r = s.snapshot();
    expect(r.routes[0]!.current.findings[0]).toMatchObject({ count: 1, savedMsSum: 90, savedN: 1 });
    expect(r.findings[0]).toMatchObject({ requests: 1, seenOnce: true, impactMs: 90 });
  });

  test("the rollup merges one fingerprint across epochs and routes", () => {
    const s = new RouteStatsStore();
    s.add(trace(100, { findings: [nplus1(50)] }, { epoch: 1 }));
    s.add(trace(100, { findings: [nplus1(50)] }, { epoch: 2 }));
    s.add(trace(100, { url: "/api/b", path: "/api/b", route: "/api/b", findings: [nplus1(50)] }, { epoch: 2 }));
    const [f] = s.snapshot().findings;
    expect(f).toMatchObject({ requests: 3, firstEpoch: 1, lastEpoch: 2, impactMs: 150 });
    expect([...f!.routes].sort()).toEqual(["GET /api/b", "GET /api/products"]);
  });

  test("a repeated dev compile stall still sinks below an actionable finding", () => {
    const s = new RouteStatsStore();
    for (let i = 0; i < 2; i++) s.add(trace(3000, { findings: [{ ...compileStall, estSavedMs: 2857 }] }));
    for (let i = 0; i < 9; i++) s.add(trace(320, { findings: [nplus1(311)] }));
    expect(s.snapshot().findings.map((f) => f.fingerprint)).toEqual(["fp-nplus1", "fp-compile"]);
  });

  test("assets stay out of the rollup", () => {
    const s = new RouteStatsStore();
    s.add(trace(5, { kind: "asset", url: "/x.js", path: "/x.js", route: undefined, findings: [nplus1(10)] }));
    expect(s.snapshot().findings).toEqual([]);
  });

  test("rankFindings: without estimates, severity then requests decide; ties are stable by fingerprint", () => {
    const base = { impactMs: 0, seenOnce: false, lastSeen: 1, rule: "duplicate" as const };
    const out = rankFindings([
      { ...base, fingerprint: "b", severity: "info" as const, requests: 5 },
      { ...base, fingerprint: "a", severity: "warn" as const, requests: 2 },
      { ...base, fingerprint: "c", severity: "warn" as const, requests: 2 },
      { ...base, fingerprint: "d", severity: "error" as const, requests: 1, seenOnce: true },
    ]);
    expect(out.map((f) => f.fingerprint)).toEqual(["a", "c", "b", "d"]);
  });

  test("rollupFindings over hand-built epochs (no saving data) gives impact 0, not NaN", () => {
    const e = {
      epoch: 3,
      lastSeen: 9,
      findings: [{ fingerprint: "x", rule: "duplicate", severity: "warn", title: "dup", count: 2 }],
    } as unknown as EpochStats;
    const [f] = rollupFindings([{ key: "GET /a", epochs: [e] }]);
    expect(f).toMatchObject({ impactMs: 0, requests: 2, seenOnce: false, lastSeen: 9 });
    expect(f!.savedMsPerRequest).toBeUndefined();
  });
});

describe("errors tally", () => {
  test("5xx, thrown and swallowed are disjoint and add up", () => {
    const s = new RouteStatsStore();
    const err = { type: "Error", message: "boom", stack: "" };
    s.add(trace(10, { status: 500 })); // returned 500 itself
    s.add(trace(10, { status: 503 }));
    s.add(trace(10, { status: 500, error: err })); // threw
    s.add(trace(10, { status: undefined, error: err })); // no status at all: failed + thrown
    for (let i = 0; i < 3; i++) s.add(trace(10, { status: 200, error: err })); // caught, still 200
    s.add(trace(10, { status: 422, error: err })); // caught, answered 4xx
    s.add(trace(10, { status: 404 })); // a plain 4xx is the client's problem
    const r = s.snapshot();
    expect(r.totals.errorKinds).toEqual({ fivexx: 2, thrown: 2, swallowed: 4 });
    expect(r.totals.errors).toBe(4);
    expect(r.routes[0]!.all.errorKinds).toEqual({ fivexx: 2, thrown: 2, swallowed: 4 });
    expect(r.routes[0]!.current.errorKinds).toEqual({ fivexx: 2, thrown: 2, swallowed: 4 });
  });

  test("the audit traffic shape: 19 = 2 / 0 / 17", () => {
    const s = new RouteStatsStore();
    const err = { type: "Error", message: "HTTP 503", stack: "" };
    s.add(trace(10, { status: 500 }));
    s.add(trace(10, { status: 500 }));
    for (let i = 0; i < 17; i++) s.add(trace(10, { status: 200, error: err }));
    for (let i = 0; i < 20; i++) s.add(trace(10));
    const k = s.snapshot().totals.errorKinds;
    expect(k.fivexx + k.thrown + k.swallowed).toBe(19);
    expect(k).toEqual({ fivexx: 2, thrown: 0, swallowed: 17 });
  });
});

describe("exemplars", () => {
  const ex = (ms: number, i: number): Exemplar => ({ traceId: `x${i}`, ms, epoch: 0 });

  test("fast = p10, typical = closest to p50, slow = max", () => {
    const list = [50, 10, 40, 20, 30, 100, 60, 70, 80, 90, 25].map(ex);
    const r = pickExemplars(list)!;
    expect(r.n).toBe(11);
    expect(r.fast.ms).toBe(20); // sorted[1] of 11
    expect(r.typical.ms).toBe(50); // median of 11
    expect(r.slow.ms).toBe(100);
  });

  test("even n: typical is the sample nearest the interpolated median, newer on a tie", () => {
    const r = pickExemplars([10, 20, 30, 40].map(ex))!;
    // median 25: 20 and 30 are equally near; 30 (index 2) is newer than 20 (index 1).
    expect(r.typical.traceId).toBe("x2");
  });

  test("one sample is all three; empty is undefined", () => {
    const r = pickExemplars([ex(7, 0)])!;
    expect([r.fast.traceId, r.typical.traceId, r.slow.traceId]).toEqual(["x0", "x0", "x0"]);
    expect(pickExemplars([])).toBeUndefined();
  });

  test("the store picks from warm requests of the kept epochs only", () => {
    const s = new RouteStatsStore({ maxEpochs: 1 });
    s.add(trace(999, { id: "old" }, { epoch: 1 }));
    s.add(trace(5000, { id: "cold" }, { epoch: 2, cold: true }));
    s.add(trace(10, { id: "a" }, { epoch: 2 }));
    s.add(trace(30, { id: "b" }, { epoch: 2 }));
    s.add(trace(20, { id: "c" }, { epoch: 2 }));
    const e = s.snapshot().routes[0]!.exemplars!;
    expect(e.n).toBe(3);
    expect(e.slow.traceId).toBe("b");
    expect(e.typical.traceId).toBe("c");
    expect(e.fast.traceId).toBe("a");
  });

  test("failed requests (5xx, thrown, caught) are never exemplars", () => {
    const s = new RouteStatsStore();
    s.add(trace(1.4, { id: "boom", status: 500, error: { type: "Error", message: "x", stack: "" } }));
    s.add(trace(2, { id: "caught", status: 200, error: { type: "Error", message: "y", stack: "" } }));
    s.add(trace(17, { id: "a" }));
    s.add(trace(40, { id: "b" }));
    const e = s.snapshot().routes[0]!.exemplars!;
    expect(e.n).toBe(2);
    expect(e.fast.traceId).toBe("a");
  });
});

describe("per-epoch p50 delta (the Overview's d-epoch column)", () => {
  test("regressed when p50 rose enough with warm n >= 3 on both sides", () => {
    const s = new RouteStatsStore();
    for (const ms of [40, 41, 42]) s.add(trace(ms, {}, { epoch: 1 }));
    for (const ms of [95, 96, 97]) s.add(trace(ms, {}, { epoch: 2 }));
    const d = s.snapshot().routes[0]!.delta!;
    expect(d).toMatchObject({ epoch: 2, baselineEpoch: 1, status: "regressed", deltaMs: 55, nBefore: 3, nAfter: 3 });
    expect(d.deltaPct).toBeCloseTo(55 / 41, 2);
    expect(d.lowConfidence).toBe(true);
  });

  test("insufficient (shown blank) when either side has warm n < 3", () => {
    const s = new RouteStatsStore();
    for (const ms of [40, 41, 42]) s.add(trace(ms, {}, { epoch: 1 }));
    s.add(trace(96, {}, { epoch: 2 }));
    s.add(trace(500, {}, { epoch: 2, cold: true }));
    expect(s.snapshot().routes[0]!.delta).toMatchObject({ status: "insufficient", nAfter: 1 });
  });

  test("absent when the route had no traffic in the newest epoch, or has no earlier epoch", () => {
    const s = new RouteStatsStore();
    for (const ms of [40, 41, 42]) s.add(trace(ms, {}, { epoch: 1 }));
    expect(s.snapshot().routes[0]!.delta).toBeUndefined(); // only one epoch
    for (const ms of [40, 41, 42]) s.add(trace(ms, {}, { epoch: 2 }));
    s.add(trace(10, { url: "/api/other", path: "/api/other", route: "/api/other" }, { epoch: 3 }));
    const products = s.snapshot().routes.find((r) => r.key === "GET /api/products")!;
    expect(products.delta).toBeUndefined(); // newest epoch is 3, products last seen in 2
  });

  test("skips back over a thin epoch to the nearest one with n >= 3", () => {
    const at = (epoch: number, warm: number, p50: number): EpochStats => ({
      epoch,
      count: warm,
      errors: 0,
      cold: 0,
      warm,
      p50,
      findings: [],
      firstSeen: 0,
      lastSeen: 0,
    });
    const r = { key: "GET /a", method: "GET", route: "/a" };
    const d = epochDelta(r, [at(1, 5, 40), at(2, 1, 400), at(3, 4, 44)], 3)!;
    expect(d).toMatchObject({ baselineEpoch: 1, status: "unchanged", deltaMs: 4 });
  });
});
