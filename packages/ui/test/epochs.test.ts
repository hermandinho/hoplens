import { describe, expect, test } from "vitest";
import type {
  EpochStats,
  EpochView,
  RouteRegression,
  ServerRouteStats,
  StatsResponse,
  TraceFacts,
  TraceSummary,
} from "../src/api/types";
import {
  ago,
  buildTimeline,
  candidateName,
  comparePair,
  describeRegression,
  dotTones,
  epochAt,
  epochLabel,
  foldToast,
  ioDelta,
  isAffected,
  knownEpochIds,
  mergeEpochStats,
  mergeRegressions,
  reconcileToast,
  regressionId,
  regressionsByEpoch,
  replayPath,
  scopeStatsSince,
  sinceNumber,
  splitAffected,
  toastText,
  tracesSince,
  viaLabel,
} from "../src/state/epochs";
import { editsOf } from "../src/state/palette";
import { scopesFor } from "../src/state/shellKeys";

/*
 * WP9b: edits, verdicts, the Changes track, the toast and the since scope. Pure functions only.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/epochs.test.ts
 */

function epoch(over: Partial<EpochView> & { id: number }): EpochView {
  return {
    at: 1_000_000 + over.id * 60_000,
    rebuiltAt: 0,
    files: [],
    deleted: [],
    moreFiles: 0,
    via: over.id === 0 ? "start" : "src-watch",
    candidates: [],
    routes: [],
    routesVia: "none",
    ...over,
  };
}

function facts(over: Partial<TraceFacts> = {}): TraceFacts {
  return {
    time: { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 },
    counts: { spans: 1, db: 0, fetch: 0, cache: 0, fn: 0, warn: 0, error: 0 },
    cold: false,
    epoch: 0,
    ...over,
  } as TraceFacts;
}

let seq = 0;
function trace(over: Partial<TraceSummary> & { epoch?: number; cold?: boolean } = {}): TraceSummary {
  const { epoch: e = 0, cold = false, ...rest } = over;
  seq++;
  return {
    id: `t${seq}`,
    startedAt: 1_000_000 + seq * 1000,
    duration: 40,
    done: true,
    method: "GET",
    path: "/api/products",
    url: "/api/products",
    route: "/api/products",
    kind: "api",
    status: 200,
    hops: 1,
    facts: facts({ epoch: e, cold }),
    ...rest,
  } as TraceSummary;
}

function verdict(over: Partial<RouteRegression> & { epoch: number }): RouteRegression {
  return {
    key: "GET /api/products",
    method: "GET",
    route: "/api/products",
    status: "regressed",
    lowConfidence: false,
    buckets: [],
    findings: { added: [], removed: [] },
    basis: "route",
    ...over,
  };
}

function es(over: Partial<EpochStats> & { epoch: number }): EpochStats {
  return {
    count: 4,
    errors: 0,
    cold: 0,
    warm: 4,
    findings: [],
    firstSeen: 1,
    lastSeen: 2,
    ...over,
  };
}

describe("epochLabel / candidateName", () => {
  test("names the saved file, then counts the rest", () => {
    expect(epochLabel(epoch({ id: 7, files: ["src/lib/store.ts"] }))).toBe("store.ts");
    expect(epochLabel(epoch({ id: 7, files: ["src/lib/store.ts", "src/a.ts"], moreFiles: 3 }))).toBe("store.ts +4");
    expect(epochLabel(epoch({ id: 7, deleted: ["src/old.ts"] }))).toBe("old.ts");
  });
  test("falls back to candidates, then to 'rebuild'; epoch 0 is the session start", () => {
    expect(epochLabel(epoch({ id: 3, via: "candidates", candidates: ["app/api/feed/route"] }))).toBe("feed/route");
    expect(
      epochLabel(epoch({ id: 3, via: "candidates", candidates: ["app/api/feed/route", "src/lib/schemas.ts"] })),
    ).toBe("one of: feed/route, schemas.ts");
    expect(epochLabel(epoch({ id: 3, via: "unknown" }))).toBe("rebuild");
    expect(epochLabel(epoch({ id: 0 }))).toBe("session start");
    expect(candidateName("src_lib_store_ts")).toBe("src_lib_store_ts");
  });
});

describe("small helpers", () => {
  test("ago and sinceNumber", () => {
    expect(ago(0, 12_000)).toBe("12s ago");
    expect(ago(0, 3 * 60_000 + 5_000)).toBe("3m ago");
    expect(ago(0, 2 * 3_600_000)).toBe("2h ago");
    expect(ago(10_000, 0)).toBe("0s ago");
    expect(sinceNumber("7")).toBe(7);
    expect(sinceNumber("3:7")).toBe(7);
    expect(sinceNumber("x")).toBeUndefined();
    expect(sinceNumber(undefined)).toBeUndefined();
  });
  test("tracesSince keeps epoch >= since only", () => {
    const list = [trace({ epoch: 1 }), trace({ epoch: 2 }), trace({ epoch: 3 })];
    expect(tracesSince(list, 2).map((t) => t.facts?.epoch)).toEqual([2, 3]);
  });
  test("viaLabel names every core attribution, chunk-diff included", () => {
    expect(viaLabel({ via: "src-watch" })).toBe("saved");
    expect(viaLabel({ via: "chunk-diff" })).toBe("from rebuilt code");
    expect(viaLabel({ via: "unknown" })).toBe("not attributed");
  });
  test("knownEpochIds unions the server's edits with the requests' epochs", () => {
    expect(knownEpochIds([{ id: 0 }, { id: 4 }], [trace({ epoch: 2 }), trace({ epoch: 4 })])).toEqual([0, 2, 4]);
  });
});

describe("mergeRegressions", () => {
  test("keeps verdicts the server stopped reporting, replaces the same route+epoch", () => {
    const a = verdict({ epoch: 2, deltaMs: 50 });
    const first = mergeRegressions(new Map(), [a]);
    const b = verdict({ epoch: 3, status: "unchanged" });
    const second = mergeRegressions(first, [b]);
    expect([...second.keys()].sort()).toEqual(["GET /api/products@2", "GET /api/products@3"]);
    const again = mergeRegressions(second, [verdict({ epoch: 3, status: "improved" })]);
    expect(again.get("GET /api/products@3")?.status).toBe("improved");
  });
  test("drops stale no-traffic rows, keeps fresh ones", () => {
    const nt = verdict({ epoch: 4, status: "no-traffic", key: "GET /api/p/[id]" });
    const m = mergeRegressions(new Map(), [nt]);
    expect(m.size).toBe(1);
    expect(mergeRegressions(m, []).size).toBe(0);
    expect(mergeRegressions(m, [nt]).size).toBe(1);
    // One SSE regression event is not the full picture: the no-traffic row stays.
    expect(mergeRegressions(m, [verdict({ epoch: 4 })], { partial: true }).size).toBe(2);
  });
  test("caps by dropping the oldest epochs", () => {
    const items = [1, 2, 3, 4].map((e) => verdict({ epoch: e }));
    const m = mergeRegressions(new Map(), items, { max: 2 });
    expect([...m.values()].map((r) => r.epoch).sort()).toEqual([3, 4]);
  });
});

describe("regressionsByEpoch / describeRegression", () => {
  test("groups by epoch, worst first", () => {
    const g = regressionsByEpoch([
      verdict({ epoch: 5, key: "GET /a", status: "unchanged" }),
      verdict({ epoch: 5, key: "GET /b", status: "no-traffic" }),
      verdict({ epoch: 5, key: "GET /c", status: "regressed", deltaMs: 10 }),
      verdict({ epoch: 5, key: "GET /d", status: "regressed", deltaMs: 55 }),
      verdict({ epoch: 4, key: "GET /a", status: "improved" }),
    ]);
    expect(g.get(5)?.map((r) => r.key)).toEqual(["GET /d", "GET /c", "GET /a", "GET /b"]);
    expect(g.get(4)?.length).toBe(1);
  });
  test("a regression reads p50 before -> after, %, io, bucket that grew, n", () => {
    const r = verdict({
      epoch: 7,
      before: { epoch: 6, n: 6, count: 6, p50: 41 },
      after: { epoch: 7, n: 7, count: 7, p50: 96 },
      deltaMs: 55,
      deltaPct: 1.34,
      grew: { bucket: "db", beforeMs: 9, afterMs: 61, deltaMs: 52 },
      io: {
        db: { before: 1, after: 50, delta: 49 },
        fetch: { before: 2, after: 2, delta: 0 },
        cache: { before: 0, after: 0, delta: 0 },
        fn: { before: 3, after: 30, delta: 27 },
      },
    });
    expect(describeRegression(r)).toEqual({
      glyph: "!",
      tone: "worse",
      p50: "41ms -> 96ms",
      pct: "+134%",
      io: "db 1 -> 50",
      grew: "db +52ms",
      n: "n 6|7",
      note: undefined,
    });
  });
  test("low confidence, unchanged, insufficient and no traffic say so", () => {
    expect(
      describeRegression(verdict({ epoch: 2, status: "improved", lowConfidence: true, deltaPct: -0.3 })).note,
    ).toBe("low confidence");
    expect(describeRegression(verdict({ epoch: 2, status: "improved", deltaPct: -0.3 })).pct).toBe("-30%");
    expect(describeRegression(verdict({ epoch: 2, status: "unchanged" })).glyph).toBe("=");
    expect(
      describeRegression(verdict({ epoch: 2, status: "insufficient", after: { epoch: 2, n: 1, count: 2 } })).note,
    ).toBe("needs 3 warm requests after the edit (has 1)");
    expect(describeRegression(verdict({ epoch: 2, status: "no-traffic" })).note).toBe("no traffic since edit");
  });
  test("ioDelta ignores sub-1 moves", () => {
    expect(
      ioDelta({
        db: { before: 1.2, after: 1.4, delta: 0.2 },
        fetch: { before: 0, after: 0, delta: 0 },
        cache: { before: 0, after: 0, delta: 0 },
        fn: { before: 0, after: 0, delta: 0 },
      }),
    ).toBeUndefined();
  });
});

describe("rebuild toast", () => {
  test("only regressions open it; same edit joins; newer replaces; older is ignored", () => {
    const r7 = verdict({ epoch: 7, deltaPct: 1.34 });
    expect(foldToast(null, verdict({ epoch: 7, status: "improved" }), "store.ts", 1)).toBeNull();
    const t1 = foldToast(null, r7, "store.ts", 1);
    expect(t1 && toastText(t1)).toBe("store.ts rebuilt · /api/products +134%");
    const t2 = foldToast(t1, verdict({ epoch: 7, key: "GET /api/catalog", route: "/api/catalog" }), "store.ts", 2);
    expect(t2 && toastText(t2)).toBe("store.ts rebuilt · /api/products +134% and 1 more");
    expect(foldToast(t2, r7, "store.ts", 3)).toBe(t2);
    expect(foldToast(t2, verdict({ epoch: 6 }), "x", 3)).toBe(t2);
    expect(foldToast(t2, verdict({ epoch: 8, deltaMs: 12 }), undefined, 4)?.label).toBe("e8");
  });

  test("a verdict that flips back leaves the toast; new numbers replace the old ones", () => {
    const t1 = foldToast(null, verdict({ epoch: 2, deltaPct: 0.38 }), "external.ts", 1);
    expect(t1 && toastText(t1)).toBe("external.ts rebuilt · /api/products +38%");
    const t2 = foldToast(t1, verdict({ epoch: 2, deltaPct: 0.45 }), "external.ts", 2);
    expect(t2 && toastText(t2)).toBe("external.ts rebuilt · /api/products +45%");
    expect(t2?.at).toBe(1); // fresh numbers don't restart the timer
    expect(foldToast(t2, verdict({ epoch: 2, status: "unchanged" }), "external.ts", 3)).toBeNull();
    // A flip of a route the toast doesn't name changes nothing.
    expect(foldToast(t2, verdict({ epoch: 2, key: "GET /x", route: "/x", status: "unchanged" }), "x", 3)).toBe(t2);
  });

  test("reconcileToast re-checks the open toast against the latest verdicts", () => {
    const a = verdict({ epoch: 2, deltaPct: 0.38 });
    const b = verdict({ epoch: 2, key: "GET /api/feed", route: "/api/feed", deltaPct: 0.5 });
    const t = foldToast(foldToast(null, a, "external.ts", 1), b, "external.ts", 2);
    const flipped = new Map([[regressionId(a), verdict({ epoch: 2, status: "unchanged" })]]);
    const r = reconcileToast(t, flipped);
    expect(r && toastText(r)).toBe("external.ts rebuilt · /api/feed +50%");
    const both = new Map([
      [regressionId(a), verdict({ epoch: 2, status: "unchanged" })],
      [regressionId(b), { ...b, status: "insufficient" as const }],
    ]);
    expect(reconcileToast(t, both)).toBeNull();
    expect(reconcileToast(t, new Map())).toBe(t);
  });
});

describe("verdicts for routes the edit doesn't touch", () => {
  const e5 = epoch({ id: 5, routes: ["/api/orders", "/api/products"], routesVia: "chunks" });
  test("isAffected: only when the routes are known (chunks / imports)", () => {
    expect(isAffected({ route: "/api/products" }, e5)).toBe(true);
    expect(isAffected({ route: "/api/feed" }, e5)).toBe(false);
    expect(isAffected({ route: "/api/feed" }, { ...e5, routesVia: "imports" })).toBe(false);
    expect(isAffected({ route: "/api/feed" }, { ...e5, routesVia: "candidates" })).toBe(true);
    expect(isAffected({ route: "/api/feed" }, undefined)).toBe(true);
  });
  test("splitAffected moves drift out of the edit's verdicts", () => {
    const feed = verdict({ epoch: 5, key: "GET /api/feed", route: "/api/feed", status: "improved" });
    const prod = verdict({ epoch: 5 });
    const other = verdict({ epoch: 4, key: "GET /api/feed", route: "/api/feed" });
    const { affected, other: drift } = splitAffected(
      new Map([
        [5, [prod, feed]],
        [4, [other]],
      ]),
      new Map([[5, e5]]),
    );
    expect(affected.get(5)).toEqual([prod]);
    expect(drift.get(5)).toEqual([feed]);
    expect(affected.get(4)).toEqual([other]); // e4's routes unknown: every verdict counts
    expect(drift.has(4)).toBe(false);
  });
});

describe("Changes track", () => {
  test("ticks and dots on one 0..1 axis, regressed ticks marked", () => {
    const eps = [epoch({ id: 0, at: 1_000_000 }), epoch({ id: 1, at: 1_050_000, files: ["src/lib/store.ts"] })];
    const traces = [trace({ startedAt: 1_000_000 }), trace({ startedAt: 1_100_000, epoch: 1 })];
    const v = regressionsByEpoch([verdict({ epoch: 1 })]);
    const tl = buildTimeline(eps, traces, v, 1_100_000);
    expect(tl.ticks.map((t) => [t.id, t.x, t.regressed])).toEqual([
      [0, 0, false],
      [1, 0.5, true],
    ]);
    expect(tl.ticks[1]?.label).toBe("e1 store.ts");
    expect(tl.dots.map((d) => d.x)).toEqual([0, 1]);
  });
  test("a long quiet stretch ends the axis at the last activity, not now", () => {
    const eps = [epoch({ id: 0, at: 1_000_000 }), epoch({ id: 1, at: 1_100_000 })];
    const quiet = buildTimeline(eps, [], new Map(), 1_000_000 + 3_600_000);
    expect(quiet.endsNow).toBe(false);
    expect(quiet.ticks[1]?.x).toBeGreaterThan(0.9);
    expect(buildTimeline(eps, [], new Map(), 1_150_000).endsNow).toBe(true);
  });
  test("crowded ticks lose their labels, the newest keeps one", () => {
    const eps = [1, 2, 3].map((id) => epoch({ id, at: 1_000_000 + id }));
    const tl = buildTimeline(eps, [], new Map(), 1_100_000);
    expect(tl.ticks.map((t) => t.showLabel)).toEqual([false, false, true]);
  });
  test("dot tones: error, slow vs the route's median, ok", () => {
    const ok1 = trace({ duration: 40 });
    const ok2 = trace({ duration: 42 });
    const slow = trace({ duration: 200 });
    const err = trace({ status: 500 });
    const tones = dotTones([ok1, ok2, slow, err]);
    expect([tones.get(ok1.id), tones.get(ok2.id), tones.get(slow.id), tones.get(err.id)]).toEqual([
      "ok",
      "ok",
      "slow",
      "error",
    ]);
  });
  test("epochAt: the edit in effect at a time", () => {
    const eps = [epoch({ id: 0, at: 100 }), epoch({ id: 1, at: 200 }), epoch({ id: 2, at: 300 })];
    expect(epochAt(eps, 250)).toBe(1);
    expect(epochAt(eps, 300)).toBe(2);
    expect(epochAt(eps, 50)).toBe(0);
    expect(epochAt([], 50)).toBeUndefined();
  });
});

describe("row actions", () => {
  test("compare pair picks the typical warm request on each side", () => {
    const a1 = trace({ epoch: 6, duration: 41 });
    const a2 = trace({ epoch: 6, duration: 90 });
    const cold = trace({ epoch: 7, duration: 96, cold: true });
    const b1 = trace({ epoch: 7, duration: 95 });
    const r = verdict({
      epoch: 7,
      baselineEpoch: 6,
      before: { epoch: 6, n: 3, count: 3, p50: 40 },
      after: { epoch: 7, n: 3, count: 3, p50: 96 },
    });
    expect(comparePair(r, [a1, a2, cold, b1])).toEqual({ a: a1.id, b: b1.id });
    expect(comparePair(r, [a1])).toBeUndefined();
    expect(comparePair({ ...r, baselineEpoch: undefined }, [a1, b1])).toBeUndefined();
  });
  test("replay path: newest retained URL, the static route, never a write", () => {
    const t = trace({ url: "/api/products?page=2" });
    expect(replayPath(verdict({ epoch: 1 }), [t])).toBe("/api/products?page=2");
    expect(replayPath(verdict({ epoch: 1 }), [])).toBe("/api/products");
    expect(replayPath(verdict({ epoch: 1, route: "/api/p/[id]", key: "GET /api/p/[id]" }), [])).toBeUndefined();
    expect(replayPath(verdict({ epoch: 1, method: "POST", key: "POST /api/products" }), [t])).toBeUndefined();
  });
});

describe("since scope over /api/stats", () => {
  const route = (over: Partial<ServerRouteStats> & { key: string; epochs: EpochStats[]; all: EpochStats }) =>
    ({
      method: "GET",
      route: over.key.split(" ")[1],
      kind: "api",
      lastSeen: 1,
      current: over.epochs[0] as EpochStats,
      ...over,
    }) as ServerRouteStats;

  test("mergeEpochStats sums counts and weights averages by their sample", () => {
    const m = mergeEpochStats([
      es({
        epoch: 2,
        count: 2,
        warm: 2,
        avg: 10,
        io: { db: 1, fetch: 0, cache: 0, fn: 0 },
        errorKinds: { fivexx: 1, thrown: 0, swallowed: 0 },
      }),
      es({
        epoch: 3,
        count: 6,
        warm: 6,
        avg: 30,
        io: { db: 5, fetch: 0, cache: 0, fn: 0 },
        errorKinds: { fivexx: 0, thrown: 1, swallowed: 2 },
      }),
    ]);
    expect(m?.count).toBe(8);
    expect(m?.avg).toBe(25);
    expect(m?.io?.db).toBe(4);
    expect(m?.epoch).toBe(3);
    expect(m?.errorKinds).toEqual({ fivexx: 1, thrown: 1, swallowed: 2 });
    expect(mergeEpochStats([])).toBeUndefined();
  });

  test("keeps only epochs >= since, drops routes without traffic there, flags a partial window", () => {
    const s: StatsResponse = {
      epoch: 7,
      since: 0,
      totals: { requests: 30, errors: 0, cold: 0, routes: 2, droppedSpans: 0 },
      routes: [
        route({
          key: "GET /api/products",
          epochs: [es({ epoch: 7, count: 3 }), es({ epoch: 6, count: 5 })],
          // Core builds `all` from the kept epochs only; the dropped ones are counted in `evicted`.
          all: es({ epoch: -1, count: 8 }),
          evicted: 12,
        }),
        route({ key: "GET /api/feed", epochs: [es({ epoch: 5, count: 10 })], all: es({ epoch: -1, count: 10 }) }),
      ],
    };
    const a = scopeStatsSince(s, 7);
    expect(a.stats.routes.map((r) => r.key)).toEqual(["GET /api/products"]);
    expect(a.stats.routes[0]?.all.count).toBe(3);
    expect(a.stats.totals.requests).toBe(3);
    expect(a.partial).toBe(false);
    // Since e2: products had 12 requests before its kept window (e6, e7): counts are a lower bound.
    const b = scopeStatsSince(s, 2);
    expect(b.stats.totals.requests).toBe(18);
    expect(b.partial).toBe(true);
    // Nothing evicted anywhere: reaching back past the oldest kept epoch is still exact.
    const exact = { ...s, routes: s.routes.map((r) => ({ ...r, evicted: undefined })) };
    expect(scopeStatsSince(exact, 2).partial).toBe(false);
  });
});

describe("shell wiring", () => {
  test("Changes has a keyboard list (j / k)", () => {
    expect(scopesFor({ view: "changes" }, null).has("list")).toBe(true);
  });
  test("palette edits carry the server's names and list edits with no traffic", () => {
    const edits = editsOf(
      [trace({ epoch: 2 })],
      [
        { id: 0, at: 1, label: "session start", files: [] },
        { id: 2, at: 5, label: "store.ts", files: ["src/lib/store.ts"] },
        { id: 3, at: 9, label: "feed.ts", files: ["src/feed.ts"] },
      ],
    );
    expect(edits.map((e) => [e.epoch, e.n, e.label])).toEqual([
      [3, 0, "feed.ts"],
      [2, 1, "store.ts"],
    ]);
  });
});

describe("Changes after a restart with persist: true", () => {
  test("only this session's edits count: not e0, not a restart's start marker, not restored ones", async () => {
    const { isSessionEdit } = await import("../src/state/epochs");
    expect(isSessionEdit(0, { via: "start" })).toBe(false);
    expect(isSessionEdit(8, { via: "start" })).toBe(false); // the restart marker
    expect(isSessionEdit(3, { via: "src-watch", session: 1 })).toBe(false);
    expect(isSessionEdit(9, { via: "src-watch" })).toBe(true);
  });
  test("restored edits count the server's requests, not only the retained ones", async () => {
    const { requestsByEpoch } = await import("../src/state/epochs");
    const m = requestsByEpoch(
      [{ kind: "route", facts: { epoch: 9 } as never }],
      [
        {
          epochs: [
            { epoch: 3, count: 6 },
            { epoch: 9, count: 1 },
          ],
        },
        { epochs: [{ epoch: 3, count: 2 }] },
      ],
    );
    expect(m.get(3)).toBe(8);
    expect(m.get(9)).toBe(1);
  });
});

describe("Changes track labels never overlap", () => {
  test("at phone width close edits leave all but one label bare; a regressed one wins", async () => {
    const { buildTimeline, labelGap } = await import("../src/state/epochs");
    const ep = (id: number, at: number) => ({
      id,
      at,
      files: [`f${id}.ts`],
      deleted: [],
      moreFiles: 0,
      via: "src-watch" as const,
      candidates: [],
    });
    const eps = [ep(0, 1_000_000), ep(1, 1_010_000), ep(5, 1_500_000), ep(7, 1_520_000)];
    const bad = new Map([[5, [{ status: "regressed" }]]]) as never;
    const tl = buildTimeline(eps, [], bad, 1_600_000, { minLabelGap: labelGap(400) });
    const shown = tl.ticks.filter((t) => t.showLabel).map((t) => t.id);
    expect(shown).toEqual([1, 5]);
    for (const a of tl.ticks.filter((t) => t.showLabel))
      for (const b of tl.ticks.filter((t) => t.showLabel && t !== a))
        expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(labelGap(400));
  });
});

describe("a revert that undid a regression is credited", () => {
  const v = (epoch: number, status: string, baselineEpoch: number) =>
    ({
      key: "GET /api/products",
      method: "GET",
      route: "/api/products",
      epoch,
      baselineEpoch,
      status,
      lowConfidence: false,
      before: { n: 6, p50: 15 },
      after: { n: 6, p50: status === "regressed" ? 94 : 16 },
      buckets: [],
      findings: { added: [], removed: [] },
      basis: "route",
    }) as never;
  test("e6 unchanged vs e4 after e5 regressed reads 'fixed the e5 regression'", async () => {
    const { annotateFixes, describeRegression } = await import("../src/state/epochs");
    const out = annotateFixes([v(5, "regressed", 4), v(6, "unchanged", 4), v(4, "unchanged", 3)]);
    const e6 = out.find((r) => r.epoch === 6)!;
    expect(e6.fixes).toBe(5);
    expect(out.find((r) => r.epoch === 4)!.fixes).toBeUndefined();
    const d = describeRegression(e6);
    expect(d).toMatchObject({ glyph: "-", tone: "better" });
    expect(d.note).toContain("fixed the e5 regression");
  });
});
