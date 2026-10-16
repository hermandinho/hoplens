// "Did my last edit make it worse?" (plan 3.5 / WP9a). Reads the per-route, per-epoch aggregates of
// RouteStatsStore (it never touches the store's internals) and compares every route-epoch with the
// route's last good baseline:
//
//   regressed  p50 rose by >= max(20%, 5ms), with warm n >= 3 on both sides
//   improved   p50 fell by the same margin
//   unchanged  otherwise
//   insufficient  the newer side has warm n < 3 (cold requests never count)
//   no-traffic    the route is affected by the latest edit but hasn't been hit since
//
// lowConfidence = min(n) < 8 (the UI dims those rows). "Last good baseline" = the most recent epoch with
// warm n >= 3 that did not itself regress, so a regression that persists across several edits keeps
// being compared with the version before it, not with the previous bad one. RouteStatsStore keeps only
// `maxEpochs` epochs per route, so the tracker remembers each route's baseline outside that window.
// Everything here runs in API handlers or after an epoch bump, never on the request path.

import { TIME_BUCKETS } from "./facts";
import type { EpochStats, FindingCount, IoAverages, RouteStats, StatsResponse, UrlVariantStats } from "./stats";
import type { TimeBucket } from "./types";

export const REGRESSION_RULE = {
  /** Relative p50 change that counts (0.2 = 20%). */
  minPct: 0.2,
  /** Absolute p50 change that counts (ms); the larger of the two thresholds applies. */
  minMs: 5,
  /** Warm requests needed on both sides. */
  minN: 3,
  /** Below this (either side) the verdict is flagged low confidence. */
  confidentN: 8,
} as const;

export type RegressionStatus = "regressed" | "improved" | "unchanged" | "insufficient" | "no-traffic";

/** One side of a comparison: a route in one epoch. */
export interface RegressionSide {
  epoch: number;
  /** Warm requests (the sample p50 comes from). */
  n: number;
  /** All requests, cold included. */
  count: number;
  p50?: number;
  p95?: number;
  /** Average self time per bucket (ms), warm requests. */
  time?: Record<TimeBucket, number>;
  /** Average I/O calls per request. */
  io?: IoAverages;
}

export interface BucketDelta {
  bucket: TimeBucket;
  beforeMs: number;
  afterMs: number;
  deltaMs: number;
}

export interface IoDelta {
  before: number;
  after: number;
  delta: number;
}

export interface RouteRegression {
  /** "GET /api/products" (RouteStats.key). */
  key: string;
  method: string;
  /** Route template, e.g. "/api/orders/[id]". */
  route: string;
  /** The newer epoch (the edit being judged). */
  epoch: number;
  /** The baseline epoch compared against (absent when there is none yet). */
  baselineEpoch?: number;
  status: RegressionStatus;
  /** min(n) < confidentN. */
  lowConfidence: boolean;
  before?: RegressionSide;
  after?: RegressionSide;
  /** after.p50 - before.p50 (ms). */
  deltaMs?: number;
  /** deltaMs / before.p50 (0.34 = +34%). */
  deltaPct?: number;
  /** The time bucket whose average grew most (absent when none grew). */
  grew?: BucketDelta;
  /** Every bucket that moved, largest growth first. */
  buckets: BucketDelta[];
  /** Average I/O count per request, before vs after. */
  io?: Record<keyof IoAverages, IoDelta>;
  /** Findings seen only after / only before the edit (by fingerprint). */
  findings: { added: FindingCount[]; removed: FindingCount[] };
  /**
   * What p50, n, time and io were compared over. "variants": only the URL variants present on both
   * sides, each weighted by its share of the newer side's warm requests, so a change in traffic mix
   * (?mode=batch before, ?mode=n1 after) is not read as a regression. "route": the whole route (no
   * variant overlap, or no variant detail).
   */
  basis: "variants" | "route";
  /** The URL variants compared when basis = "variants". */
  urls?: string[];
}

export interface RegressionsResponse {
  /** Newest epoch overall. */
  epoch: number;
  rule: typeof REGRESSION_RULE;
  /** Newest epoch first, then regressed before improved before the rest, then by key. */
  items: RouteRegression[];
}

/** Routes the latest edit affects (from epoch attribution), for "no traffic since edit" rows. */
export interface AffectedRoutes {
  epoch: number;
  /** Route templates with the methods discovery found for them. */
  routes: { route: string; methods: string[] }[];
}

const round = (n: number) => Math.round(n * 100) / 100;

function side(e: EpochStats): RegressionSide {
  return { epoch: e.epoch, n: e.warm, count: e.count, p50: e.p50, p95: e.p95, time: e.time, io: e.io };
}

/**
 * Both sides restricted to the URL variants they share, weighted by the newer side's warm counts.
 * Undefined when no variant has warm samples on both sides.
 */
function variantSides(
  before: EpochStats,
  after: EpochStats,
): { before: RegressionSide; after: RegressionSide; urls: string[] } | undefined {
  if (!before.variants?.length || !after.variants?.length) return undefined;
  const prev = new Map(before.variants.map((v) => [v.url, v]));
  const pairs: [UrlVariantStats, UrlVariantStats][] = [];
  for (const a of after.variants) {
    const b = prev.get(a.url);
    if (b && a.warm > 0 && b.warm > 0 && a.p50 !== undefined && b.p50 !== undefined) pairs.push([b, a]);
  }
  if (!pairs.length) return undefined;
  const wsum = pairs.reduce((s, [, a]) => s + a.warm, 0);
  const weigh = (pick: (v: UrlVariantStats) => number | undefined, which: 0 | 1): number | undefined => {
    let acc = 0;
    for (const p of pairs) {
      const x = pick(p[which]);
      if (x === undefined) return undefined;
      acc += x * p[1].warm;
    }
    return round(acc / wsum);
  };
  const mk = (e: EpochStats, which: 0 | 1): RegressionSide => {
    const out: RegressionSide = {
      epoch: e.epoch,
      n: pairs.reduce((s, p) => s + p[which].warm, 0),
      count: pairs.reduce((s, p) => s + p[which].count, 0),
      p50: weigh((v) => v.p50, which),
      p95: weigh((v) => v.p95, which),
    };
    if (pairs.every((p) => p[which].time)) {
      const time = {} as Record<TimeBucket, number>;
      for (const b of TIME_BUCKETS) time[b] = weigh((v) => v.time?.[b], which) ?? 0;
      out.time = time;
    }
    if (pairs.every((p) => p[which].io)) {
      out.io = {
        db: weigh((v) => v.io?.db, which) ?? 0,
        fetch: weigh((v) => v.io?.fetch, which) ?? 0,
        cache: weigh((v) => v.io?.cache, which) ?? 0,
        fn: weigh((v) => v.io?.fn, which) ?? 0,
      };
    }
    return out;
  };
  return { before: mk(before, 0), after: mk(after, 1), urls: pairs.map(([, a]) => a.url) };
}

/** Compare one route-epoch with its baseline. Exported for tests. */
export function compareEpochs(
  r: Pick<RouteStats, "key" | "method" | "route">,
  before: EpochStats | undefined,
  after: EpochStats,
): RouteRegression {
  const out: RouteRegression = {
    key: r.key,
    method: r.method,
    route: r.route,
    epoch: after.epoch,
    baselineEpoch: before?.epoch,
    status: "insufficient",
    lowConfidence: true,
    before: before ? side(before) : undefined,
    after: side(after),
    buckets: [],
    findings: { added: [], removed: [] },
    basis: "route",
  };
  if (!before) return out;

  const mixed = variantSides(before, after);
  if (mixed) {
    out.before = mixed.before;
    out.after = mixed.after;
    out.basis = "variants";
    out.urls = mixed.urls;
  }
  const b = out.before!;
  const a = out.after!;
  const nb = b.n;
  const na = a.n;
  out.lowConfidence = Math.min(nb, na) < REGRESSION_RULE.confidentN;
  if (b.p50 !== undefined && a.p50 !== undefined) {
    out.deltaMs = round(a.p50 - b.p50);
    out.deltaPct = b.p50 > 0 ? round((a.p50 - b.p50) / b.p50) : undefined;
  }
  if (nb >= REGRESSION_RULE.minN && na >= REGRESSION_RULE.minN && out.deltaMs !== undefined) {
    const threshold = Math.max(REGRESSION_RULE.minPct * b.p50!, REGRESSION_RULE.minMs);
    out.status = out.deltaMs >= threshold ? "regressed" : -out.deltaMs >= threshold ? "improved" : "unchanged";
  }

  compareDetail(out, b, a);
  const fpBefore = new Map(before.findings.map((f) => [f.fingerprint, f]));
  const fpAfter = new Map(after.findings.map((f) => [f.fingerprint, f]));
  for (const [fp, f] of fpAfter) if (!fpBefore.has(fp)) out.findings.added.push(f);
  for (const [fp, f] of fpBefore) if (!fpAfter.has(fp)) out.findings.removed.push(f);
  return out;
}

/** Bucket and I/O deltas between the two (already variant-matched) sides. */
function compareDetail(out: RouteRegression, before: RegressionSide, after: RegressionSide): void {
  if (before.time && after.time) {
    for (const b of TIME_BUCKETS) {
      const d = round((after.time[b] ?? 0) - (before.time[b] ?? 0));
      if (d !== 0)
        out.buckets.push({ bucket: b, beforeMs: before.time[b] ?? 0, afterMs: after.time[b] ?? 0, deltaMs: d });
    }
    out.buckets.sort((x, y) => y.deltaMs - x.deltaMs);
    if (out.buckets[0] && out.buckets[0].deltaMs > 0) out.grew = out.buckets[0];
  }
  if (before.io && after.io) {
    const io = {} as Record<keyof IoAverages, IoDelta>;
    for (const k of ["db", "fetch", "cache", "fn"] as const)
      io[k] = { before: before.io[k], after: after.io[k], delta: round(after.io[k] - before.io[k]) };
    out.io = io;
  }
}

const STATUS_ORDER: Record<RegressionStatus, number> = {
  regressed: 0,
  improved: 1,
  "no-traffic": 2,
  unchanged: 3,
  insufficient: 4,
};

/**
 * Per-route comparisons with a "last good" baseline that outlives RouteStatsStore's epoch window.
 * One per Runtime; call `evaluate()` from handlers and after each epoch bump.
 */
export class RegressionTracker {
  /** route key -> last good epoch stats (warm n >= minN, not regressed). Insertion = recency. */
  private readonly baselines = new Map<string, EpochStats>();
  /**
   * `key@epoch` -> the last decided verdict (regressed / improved / unchanged) for it. Once the store
   * drops the baseline epoch a verdict used, a later evaluate can't rebuild it (it would compare with
   * whatever is kept, or nothing): the remembered one stands in. Insertion = recency.
   */
  private readonly history = new Map<string, RouteRegression>();

  constructor(
    private readonly maxRoutes = 500,
    private readonly maxHistory = 1000,
  ) {}

  clear(): void {
    this.baselines.clear();
    this.history.clear();
  }

  /** Baseline remembered for a route (tests / diagnostics). */
  baseline(key: string): EpochStats | undefined {
    return this.baselines.get(key);
  }

  private remember(id: string, v: RouteRegression): void {
    this.history.delete(id);
    this.history.set(id, v);
    if (this.history.size > this.maxHistory) {
      const oldest = this.history.keys().next().value;
      if (oldest !== undefined) this.history.delete(oldest);
    }
  }

  evaluate(stats: StatsResponse, affected?: AffectedRoutes): RegressionsResponse {
    const items: RouteRegression[] = [];
    let newest = stats.epoch;
    if (affected && affected.epoch > newest) newest = affected.epoch;
    const byRoute = new Map<string, RouteStats[]>();
    /** route key -> its oldest kept epoch: remembered verdicts for older epochs are listed as is. */
    const oldestKeptOf = new Map<string, number>();

    for (const r of stats.routes) {
      const list = byRoute.get(r.route);
      if (list) list.push(r);
      else byRoute.set(r.route, [r]);

      const kept = [...r.epochs].sort((a, b) => a.epoch - b.epoch);
      if (!kept.length) continue;
      const remembered = this.baselines.get(r.key);
      // A remembered baseline only stands in for epochs the store already dropped.
      let baseline = remembered && remembered.epoch < kept[0]!.epoch ? remembered : undefined;
      const oldestKept = kept[0]!.epoch;
      oldestKeptOf.set(r.key, oldestKept);
      for (const e of kept) {
        let verdict: RouteRegression | undefined;
        if (baseline && e.epoch > baseline.epoch) verdict = compareEpochs(r, baseline, e);
        const id = `${r.key}@${e.epoch}`;
        const past = this.history.get(id);
        // The remembered verdict wins only when the baseline it used is gone from the store.
        const lost = past?.baselineEpoch !== undefined && past.baselineEpoch < oldestKept;
        if (past && lost && (!verdict || verdict.baselineEpoch !== past.baselineEpoch)) verdict = past;
        else if (verdict && DECIDED.has(verdict.status)) this.remember(id, verdict);
        if (verdict) items.push(verdict);
        if (e.warm >= REGRESSION_RULE.minN && verdict?.status !== "regressed") baseline = e;
      }
      if (baseline) {
        this.baselines.delete(r.key);
        this.baselines.set(r.key, stripBaseline(baseline));
        if (this.baselines.size > this.maxRoutes) {
          const oldest = this.baselines.keys().next().value;
          if (oldest !== undefined) this.baselines.delete(oldest);
        }
      }
    }

    // Verdicts for epochs the store no longer keeps (several edits ago, or before a restart replayed
    // with persist: true): they can't be recomputed, the remembered ones still stand.
    for (const v of this.history.values()) {
      const oldest = oldestKeptOf.get(v.key);
      if (oldest !== undefined && v.epoch < oldest) items.push(v);
    }

    // Routes the latest edit touched that haven't been hit since: "no traffic since edit".
    if (affected) {
      for (const a of affected.routes) {
        const seen = byRoute.get(a.route) ?? [];
        const keys = new Set(seen.map((s) => s.key));
        for (const s of seen) {
          if (s.current.epoch >= affected.epoch) continue;
          items.push(noTraffic(s.key, s.method, s.route, affected.epoch, this.baselines.get(s.key)));
        }
        if (!seen.length) {
          for (const m of a.methods) {
            const key = `${m} ${a.route}`;
            if (!keys.has(key)) items.push(noTraffic(key, m, a.route, affected.epoch, undefined));
          }
        }
      }
    }

    items.sort(
      (a, b) => b.epoch - a.epoch || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.key.localeCompare(b.key),
    );
    return { epoch: newest, rule: REGRESSION_RULE, items };
  }
}

const DECIDED = new Set<RegressionStatus>(["regressed", "improved", "unchanged"]);

function noTraffic(
  key: string,
  method: string,
  route: string,
  epoch: number,
  baseline: EpochStats | undefined,
): RouteRegression {
  return {
    key,
    method,
    route,
    epoch,
    baselineEpoch: baseline?.epoch,
    status: "no-traffic",
    lowConfidence: true,
    before: baseline ? side(baseline) : undefined,
    buckets: [],
    findings: { added: [], removed: [] },
    basis: "route",
  };
}

/** Drop the histogram from a remembered baseline. Variants stay: comparisons match on them. */
function stripBaseline(e: EpochStats): EpochStats {
  const { buckets: _b, ...rest } = e;
  return rest;
}
