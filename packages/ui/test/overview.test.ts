import { describe, expect, test } from "vitest";
import type { FindingRollup, FindingSummary, StatsResponse, TraceFacts, TraceSummary } from "../src/api/types";
import { matchQuery, parseQuery, summaryTarget } from "../src/state/query";
import { mergeFindingGroups, serverErrorTally, serverRouteStats } from "../src/state/serverStats";
import {
  ERROR_QUERIES,
  type FindingGroup,
  type RouteStats,
  computeRouteStats,
  deltaLabel,
  errorQueryFor,
  errorTally,
  groupFindings,
  holdOrder,
  overviewHero,
  pickExemplars,
  routeExemplars,
  routeOfKey,
  sortRouteStats,
} from "../src/state/stats";

/*
 * WP5 Overview logic: impact ranking with "seen once", the errors line, exemplars, the hold order,
 * the hero choice and the d-epoch label. Pure functions only.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/overview.test.ts
 */

let seq = 0;
function facts(over: Partial<TraceFacts> = {}): TraceFacts {
  return {
    time: { db: 1, cache: 0, ext: 0, fn: 1, framework: 0, compile: 0, idle: 0 },
    reqBytes: 0,
    resBytes: 0,
    counts: { spans: 3, db: 1, fetch: 0, cache: 0, fn: 1, warn: 0, error: 0 },
    cold: false,
    compileMs: 0,
    droppedSpans: 0,
    epoch: 0,
    ...over,
  };
}

function trace(over: Partial<TraceSummary> = {}, f: Partial<TraceFacts> = {}): TraceSummary {
  seq++;
  return {
    id: `t${seq}`,
    startedAt: 1000 + seq,
    duration: 100,
    done: true,
    method: "GET",
    path: "/api/feed",
    url: "/api/feed",
    route: "/api/feed",
    kind: "route",
    status: 200,
    hops: 3,
    facts: facts(f),
    ...over,
  } as TraceSummary;
}

const nplus1 = (saved: number | undefined): FindingSummary => ({
  rule: "n-plus-1",
  severity: "warn",
  title: "getPosts fetched GET host/users/:id x10 via getUser() (N+1)",
  fingerprint: "fp-n1",
  fn: "getPosts",
  location: { file: "src/lib/external.ts", line: 63 },
  count: 10,
  estSavedMs: saved,
});

const stall: FindingSummary = {
  rule: "cold-compile",
  severity: "error",
  title: "12.5s compiling",
  fingerprint: "fp-cc",
  estSavedMs: 12_500,
};

describe("groupFindings: impact ranking", () => {
  test("a repeatable N+1 outranks a one-request compile stall worth more ms", () => {
    const traces = [
      ...Array.from({ length: 9 }, () => trace({ findings: [nplus1(173)] })),
      trace({ path: "/api/catalog", url: "/api/catalog", route: "/api/catalog", findings: [stall] }),
    ];
    const g = groupFindings(traces);
    expect(g.map((x) => x.fingerprint)).toEqual(["fp-n1", "fp-cc"]);
    expect(g[0]).toMatchObject({ requests: 9, seenOnce: false, savedMsPerRequest: 173, impactMs: 1557 });
    expect(g[1]).toMatchObject({ requests: 1, seenOnce: true, impactMs: 12_500 });
  });

  test("per request is the mean of the estimates; impact counts requests without one too", () => {
    const g = groupFindings([
      trace({ findings: [nplus1(100)] }),
      trace({ findings: [nplus1(200)] }),
      trace({ findings: [nplus1(undefined)] }),
    ]);
    expect(g[0]).toMatchObject({ requests: 3, savedMsPerRequest: 150, impactMs: 450 });
  });

  test("one fingerprint twice in a trace is one request with the larger saving", () => {
    const g = groupFindings([trace({ findings: [nplus1(40), nplus1(90)] })]);
    expect(g[0]).toMatchObject({ requests: 1, savedMsPerRequest: 90, impactMs: 90, seenOnce: true });
  });

  test("among repeatable findings the larger total wins, not the larger per-request saving", () => {
    const big: FindingSummary = { ...nplus1(300), fingerprint: "fp-big" };
    const traces = [
      trace({ findings: [big] }),
      trace({ findings: [big] }), // 300 x 2 = 600
      ...Array.from({ length: 5 }, () => trace({ findings: [nplus1(150)] })), // 150 x 5 = 750
    ];
    expect(groupFindings(traces).map((x) => x.fingerprint)).toEqual(["fp-n1", "fp-big"]);
  });
});

describe("errorTally", () => {
  test("5xx, thrown and swallowed are disjoint and add up (the audit's 19 = 2/0/17)", () => {
    const traces = [
      trace({ status: 500 }),
      trace({ status: 502 }),
      ...Array.from({ length: 17 }, () => trace({ status: 200, error: "Error: HTTP 503" })),
      trace({ status: 404 }),
      trace({}),
    ];
    expect(errorTally(traces)).toEqual({ fivexx: 2, thrown: 0, swallowed: 17, total: 19 });
  });

  test("a failure with an exception is thrown, with or without a status; assets and unfinished are out", () => {
    const t = errorTally([
      trace({ status: 500, error: "TypeError: x" }),
      trace({ status: undefined, error: "socket hang up" }),
      trace({ status: 500, kind: "asset" }),
      trace({ status: 500, done: false }),
    ]);
    expect(t).toEqual({ fivexx: 0, thrown: 2, swallowed: 0, total: 2 });
  });

  test("serverErrorTally sums the routes' split and gives up on an older core", () => {
    const route = (k?: { fivexx: number; thrown: number; swallowed: number }, kind = "route") => ({
      key: "GET /a",
      method: "GET",
      route: "/a",
      kind,
      lastSeen: 0,
      current: {} as never,
      epochs: [],
      all: { errorKinds: k } as never,
    });
    const s = {
      routes: [
        route({ fivexx: 1, thrown: 2, swallowed: 3 }),
        route({ fivexx: 1, thrown: 0, swallowed: 14 }),
        route(undefined, "asset"),
      ],
    } as unknown as StatsResponse;
    expect(serverErrorTally(s)).toEqual({ fivexx: 2, thrown: 2, swallowed: 17, total: 21 });
    const old = { routes: [route(undefined)] } as unknown as StatsResponse;
    expect(serverErrorTally(old)).toBeUndefined();
  });
});

describe("exemplars", () => {
  test("fast = p10, typical = nearest the p50, slow = max", () => {
    const picks = [50, 10, 40, 20, 30, 100, 60, 70, 80, 90, 25].map((ms, i) => ({ traceId: `x${i}`, ms }));
    const e = pickExemplars(picks)!;
    expect([e.fast.ms, e.typical.ms, e.slow.ms, e.n]).toEqual([20, 50, 100, 11]);
  });

  test("routeExemplars: only this route's warm requests, cold only on request", () => {
    const a = trace({ duration: 10 });
    const b = trace({ duration: 30 });
    const c = trace({ duration: 20 });
    const cold = trace({ duration: 9000 }, { cold: true });
    const other = trace({ duration: 5, path: "/b", url: "/b", route: "/b" });
    const list = [a, b, c, cold, other];
    const e = routeExemplars(list, "GET /api/feed", false)!;
    expect([e.fast.traceId, e.typical.traceId, e.slow.traceId]).toEqual([a.id, c.id, b.id]);
    expect(routeExemplars(list, "GET /api/feed", true)!.slow.traceId).toBe(cold.id);
    expect(routeExemplars(list, "GET /nope", false)).toBeUndefined();
  });

  test("routeExemplars: a fast failure is not the route's fast run, unless every request failed", () => {
    const boom = trace({ duration: 1.4, status: 500, error: "thrown" });
    const caught = trace({ duration: 2, status: 200, error: "caught" });
    const a = trace({ duration: 17 });
    const b = trace({ duration: 40 });
    const e = routeExemplars([boom, caught, a, b], "GET /api/feed", false)!;
    expect(e.fast.traceId).toBe(a.id);
    expect(e.n).toBe(2);
    expect(routeExemplars([boom], "GET /api/feed", false)?.fast.traceId).toBe(boom.id);
  });
});

describe("holdOrder: stable under live updates", () => {
  test("kept rows keep the order on screen; new rows go to the end", () => {
    const next = [{ k: "c" }, { k: "new" }, { k: "a" }, { k: "b" }];
    expect(holdOrder(["a", "b", "c"], next, (x) => x.k).map((x) => x.k)).toEqual(["a", "b", "c", "new"]);
  });

  test("a row that went away is simply gone; no previous order = the new order", () => {
    expect(holdOrder(["a", "b", "c"], [{ k: "c" }, { k: "a" }], (x) => x.k).map((x) => x.k)).toEqual(["a", "c"]);
    expect(holdOrder(null, [{ k: "z" }, { k: "y" }], (x) => x.k).map((x) => x.k)).toEqual(["z", "y"]);
  });
});

describe("overviewHero", () => {
  const routes = (traces: TraceSummary[]): RouteStats[] => computeRouteStats(traces, false);
  const none = { fivexx: 0, thrown: 0, swallowed: 0, total: 0 };

  test("the #1 repeatable finding, never a seen-once one", () => {
    const traces = [
      ...Array.from({ length: 3 }, () => trace({ findings: [nplus1(173)] })),
      trace({ findings: [stall] }),
    ];
    const h = overviewHero(groupFindings(traces), routes(traces), none, traces.length);
    expect(h.kind).toBe("finding");
    expect(h.finding?.fingerprint).toBe("fp-n1");
    expect(h.routes).toEqual(["GET /api/feed"]);
  });

  test("a repeated dev compile stall is never the hero and ranks after actionable findings", () => {
    const traces = [
      trace({ findings: [{ ...stall, estSavedMs: 2857 }] }),
      trace({ findings: [{ ...stall, estSavedMs: 2857 }] }),
      ...Array.from({ length: 2 }, () => trace({ findings: [nplus1(50)] })),
    ];
    const g = groupFindings(traces);
    expect(g.map((x) => x.fingerprint)).toEqual(["fp-n1", "fp-cc"]);
    expect(overviewHero(g, routes(traces), none, 4).finding?.fingerprint).toBe("fp-n1");
  });

  test("a finding saving < 10ms a request is not the hero; errors are next", () => {
    const traces = [trace({ findings: [nplus1(4)] }), trace({ findings: [nplus1(4)] })];
    const errs = { fivexx: 0, thrown: 0, swallowed: 2, total: 2 };
    expect(overviewHero(groupFindings(traces), routes(traces), errs, 2).kind).toBe("errors");
  });

  test("otherwise no problems, naming the slowest route; seen-once findings are counted", () => {
    const traces = [
      trace({ duration: 40 }),
      trace({ duration: 300, path: "/b", url: "/b", route: "/b" }),
      trace({ path: "/c", url: "/c", route: "/c", findings: [stall] }),
    ];
    const h = overviewHero(groupFindings(traces), routes(traces), none, 3);
    expect(h).toMatchObject({ kind: "clean", seenOnce: 1, slowest: { key: "GET /b", p50: 300 } });
    expect(overviewHero([], [], none, 0).kind).toBe("empty");
  });
});

describe("routes", () => {
  test("time spent ranks a busy fast route over a slow one hit once", () => {
    const traces = [
      ...Array.from({ length: 20 }, () => trace({ duration: 30 })), // 600ms
      trace({ duration: 500, path: "/slow", url: "/slow", route: "/slow" }),
    ];
    const rows = computeRouteStats(traces, false);
    expect(sortRouteStats(rows, "time").map((r) => r.key)).toEqual(["GET /api/feed", "GET /slow"]);
    expect(sortRouteStats(rows, "p95").map((r) => r.key)).toEqual(["GET /slow", "GET /api/feed"]);
    expect(rows.find((r) => r.key === "GET /api/feed")?.totalMs).toBe(600);
  });

  test("server rows carry time spent, the delta and exemplars", () => {
    const s = {
      routes: [
        {
          key: "GET /a",
          method: "GET",
          route: "/a",
          kind: "route",
          lastSeen: 5,
          current: {},
          epochs: [],
          all: { count: 4, errors: 0, cold: 1, warm: 3, avg: 20, p50: 19, p95: 25, findings: [] },
          delta: {
            epoch: 2,
            baselineEpoch: 1,
            status: "regressed",
            deltaMs: 55,
            nBefore: 3,
            nAfter: 3,
            lowConfidence: true,
            basis: "route",
          },
          exemplars: {
            fast: { traceId: "f", ms: 10, epoch: 2 },
            typical: { traceId: "t", ms: 19, epoch: 2 },
            slow: { traceId: "s", ms: 25, epoch: 2 },
            n: 3,
          },
        },
      ],
    } as unknown as StatsResponse;
    const [r] = serverRouteStats(s, new Map());
    expect(r).toMatchObject({ totalMs: 60, delta: { deltaMs: 55 }, exemplars: { typical: { traceId: "t" } } });
  });

  test("deltaLabel: signed ms, '=' when unchanged, blank when n < 3 or no data", () => {
    const d = { epoch: 2, baselineEpoch: 1, nBefore: 3, nAfter: 3, lowConfidence: true, basis: "route" as const };
    expect(deltaLabel({ ...d, status: "regressed", deltaMs: 84.4 })).toBe("+84");
    expect(deltaLabel({ ...d, status: "improved", deltaMs: -12 })).toBe("-12");
    expect(deltaLabel({ ...d, status: "unchanged", deltaMs: 2 })).toBe("=");
    expect(deltaLabel({ ...d, status: "insufficient", deltaMs: 40 })).toBeUndefined();
    expect(deltaLabel(undefined)).toBeUndefined();
  });

  test("routeOfKey strips the method for prose", () => {
    expect(routeOfKey("GET /api/feed")).toBe("/api/feed");
    expect(routeOfKey("/plain path")).toBe("/plain path");
  });
});

describe("mergeFindingGroups: server rollup + tab", () => {
  const rollup = (over: Partial<FindingRollup>): FindingRollup => ({
    fingerprint: "fp-n1",
    rule: "n-plus-1",
    severity: "warn",
    title: "server title",
    requests: 40,
    routes: ["GET /api/feed"],
    savedMsPerRequest: 170,
    impactMs: 6800,
    seenOnce: false,
    firstEpoch: 0,
    lastEpoch: 0,
    lastSeen: 10,
    lastTraceId: "evicted",
    ...over,
  });

  test("server counts win (they survive eviction); the example request must still be retained", () => {
    const client = groupFindings([trace({ id: "kept", findings: [nplus1(173)] })]);
    const [g] = mergeFindingGroups(client, [rollup({})], () => false);
    expect(g).toMatchObject({ requests: 40, impactMs: 6800, seenOnce: false, latestTraceId: "kept" });
    const [onlyServer] = mergeFindingGroups([], [rollup({})], () => false);
    expect(onlyServer!.latestTraceId).toBe("");
    const [retained] = mergeFindingGroups([], [rollup({ lastTraceId: "still" })], (id) => id === "still");
    expect(retained!.latestTraceId).toBe("still");
  });

  test("tab-only rows are kept, and the merged list is re-ranked with seen-once last", () => {
    const client: FindingGroup[] = groupFindings([trace({ findings: [stall] })]);
    const out = mergeFindingGroups(client, [rollup({})], () => true);
    expect(out.map((g) => g.fingerprint)).toEqual(["fp-n1", "fp-cc"]);
    expect(mergeFindingGroups(client, undefined, () => true)).toEqual(client);
  });
});

/* R2: the errors line's filters list exactly what each count counts. */

describe("errors line queries", () => {
  const list = [
    trace({ status: 500 }),
    trace({ status: 503, error: "boom" }),
    trace({ status: undefined, error: "threw before a status" }),
    trace({ status: 200, error: "caught" }),
    trace({ status: 404 }),
    trace({ status: 200 }),
  ];
  const count = (q: string) => list.filter((t) => matchQuery(parseQuery(q), summaryTarget(t))).length;

  test("each part's filter matches its count, a status-less throw included", () => {
    const e = errorTally(list);
    expect(e).toMatchObject({ fivexx: 1, thrown: 2, swallowed: 1 });
    expect(count(ERROR_QUERIES.fivexx)).toBe(e.fivexx);
    expect(count(ERROR_QUERIES.thrown)).toBe(e.thrown);
    expect(count(ERROR_QUERIES.swallowed)).toBe(e.swallowed);
  });

  test("'List the failed ones' covers 5xx and thrown together", () => {
    const e = errorTally(list);
    expect(count(errorQueryFor(e))).toBe(e.fivexx + e.thrown);
    const onlyThrown = errorTally([list[2] as TraceSummary]);
    expect(count(errorQueryFor(onlyThrown))).toBe(2);
    expect(errorQueryFor(onlyThrown)).toBe(ERROR_QUERIES.thrown);
  });
});

describe("NEXT is epoch-aware: a finding the last edit fixed is marked, not current", () => {
  const g = (fp: string, lastEpoch: number, routes: string[], impactMs = 100) =>
    ({
      fingerprint: fp,
      rule: "parallelizable",
      severity: "info",
      title: fp,
      requests: 5,
      impactMs,
      savedMsPerRequest: impactMs / 5,
      seenOnce: false,
      routes,
      latestTraceId: "",
      latestAt: 0,
      firstAt: 0,
      isNew: false,
      lastEpoch,
    }) as import("../src/state/stats").FindingGroup;

  test("every route hit again after the finding's last epoch: goneSince, ranked after current ones", async () => {
    const { markGone, isLowSignal } = await import("../src/state/stats");
    const newest = new Map([
      ["GET /api/products", 6],
      ["GET /api/feed", 5],
    ]);
    const out = markGone([g("old", 5, ["GET /api/products"], 900), g("cur", 5, ["GET /api/feed"], 10)], newest);
    expect(out.map((x) => x.fingerprint)).toEqual(["cur", "old"]);
    expect(out[1]!.goneSince).toBe(5);
    expect(isLowSignal(out[1]!)).toBe(true);
    expect(out[0]!.goneSince).toBeUndefined();
  });

  test("a route with no newer traffic keeps the finding current", async () => {
    const { markGone } = await import("../src/state/stats");
    const out = markGone([g("a", 5, ["GET /api/products", "GET /api/x"])], new Map([["GET /api/products", 6]]));
    expect(out[0]!.goneSince).toBeUndefined();
  });

  test("newest epoch per route merges retained requests and the server's kept epochs", async () => {
    const { newestEpochByRoute } = await import("../src/state/stats");
    const m = newestEpochByRoute(
      [{ method: "GET", route: "/a", path: "/a", facts: { epoch: 2 } as TraceFacts }],
      [
        {
          key: "GET /a",
          epochs: [
            { epoch: 4, count: 3 },
            { epoch: 7, count: 0 },
          ],
        },
      ],
    );
    expect(m.get("GET /a")).toBe(4);
  });
});
