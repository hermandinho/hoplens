import { effect, signal } from "@preact/signals";
import { HoplensApiError, api } from "../api/client";
import type {
  EpochStats,
  FindingSeverity,
  HistogramBucket,
  ServerRouteStats,
  StatsResponse,
  TimeBucket,
} from "../api/types";
import { clearedAt, liveActivity, throttle } from "./activity";
import { type Kpis, type Percentiles, type RouteBadge, type RouteStats, worseSeverity } from "./stats";

/*
 * Server-side route stats (GET /api/stats?buckets=1). They survive ring-buffer eviction and are
 * kept per dev-rebuild epoch; cold requests are always out of the server's histograms. The store
 * prefers them over the client-side reduction while "Include cold" is off, and falls back to the
 * client stats when the endpoint is missing (older core), failing, or cold requests are wanted.
 */

export type ServerStatsState = "idle" | "loading" | "ready" | "error" | "unavailable";

export const serverStats = signal<StatsResponse | null>(null);
export const serverStatsState = signal<ServerStatsState>("idle");

const REFRESH_MS = 1500;
let inflight = false;
let again = false;

export async function refreshServerStats(): Promise<void> {
  if (serverStatsState.value === "unavailable") return;
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  if (!serverStats.value) serverStatsState.value = "loading";
  try {
    const s = await api.stats(true);
    serverStats.value = s;
    serverStatsState.value = "ready";
  } catch (err) {
    // 404: a core without /api/stats. Stop asking; the client stats carry on.
    if (err instanceof HoplensApiError && err.status === 404) {
      serverStats.value = null;
      serverStatsState.value = "unavailable";
    } else {
      // Keep the last good snapshot; with none, the store falls back to client stats.
      serverStatsState.value = "error";
    }
  } finally {
    inflight = false;
    if (again) {
      again = false;
      scheduleStatsRefresh();
    }
  }
}

const scheduleStatsRefresh = throttle(() => void refreshServerStats(), REFRESH_MS);

// Refetch on every done / update / clear / bootstrap, throttled.
effect(() => {
  if (liveActivity.value === 0) return;
  scheduleStatsRefresh();
});
// Clear empties the server store too: drop the stale snapshot right away.
effect(() => {
  if (clearedAt.value === 0) return;
  serverStats.value = null;
});

/* ----------------------------------------------------------- pure helpers */

/** Merge histogram bucket lists (same fixed log buckets on the server, keyed by `lo`). */
export function mergeBuckets(lists: ReadonlyArray<readonly HistogramBucket[] | undefined>): HistogramBucket[] {
  const by = new Map<number, HistogramBucket>();
  for (const list of lists) {
    for (const b of list ?? []) {
      const cur = by.get(b.lo);
      if (cur) cur.count += b.count;
      else by.set(b.lo, { ...b });
    }
  }
  return [...by.values()].sort((a, b) => a.lo - b.lo);
}

/**
 * Quantile over histogram buckets: nearest rank, interpolated linearly inside its bucket and clamped
 * to the observed [min, max] (the server's own definition). Undefined for an empty histogram.
 */
export function quantileFromBuckets(
  buckets: readonly HistogramBucket[],
  q: number,
  min?: number,
  max?: number,
): number | undefined {
  let n = 0;
  for (const b of buckets) n += b.count;
  if (n === 0) return undefined;
  if (!(q > 0) && min !== undefined) return min;
  if (q >= 1 && max !== undefined) return max;
  // Same as core's LogHistogram.quantile: nearest rank, interpolated inside the bucket between
  // max(bucket low, min) and min(bucket high, max).
  const rank = Math.min(n, Math.max(1, Math.ceil(Math.min(1, Math.max(0, q)) * n)));
  let seen = 0;
  let value: number | undefined;
  for (const b of buckets) {
    if (b.count === 0) continue;
    if (seen + b.count >= rank) {
      const lo = Math.max(b.lo, min ?? b.lo);
      const hi = Math.min(b.hi ?? Number.POSITIVE_INFINITY, max ?? b.hi ?? b.lo * 2);
      value = hi > lo ? lo + ((hi - lo) * (rank - seen)) / b.count : lo;
      break;
    }
    seen += b.count;
  }
  if (value === undefined) {
    const last = buckets[buckets.length - 1];
    value = last ? (last.hi ?? last.lo) : undefined;
  }
  if (value === undefined) return undefined;
  if (min !== undefined && value < min) value = min;
  if (max !== undefined && value > max) value = max;
  return value;
}

/** p50 / p95 / n over several epoch aggregates (one route across methods, or the whole app). */
export function mergedPercentiles(list: readonly EpochStats[]): Percentiles {
  if (list.length === 1) {
    const e = list[0] as EpochStats;
    return { p50: e.p50, p95: e.p95, n: e.warm };
  }
  let n = 0;
  let min: number | undefined;
  let max: number | undefined;
  for (const e of list) {
    n += e.warm;
    if (e.min !== undefined) min = min === undefined ? e.min : Math.min(min, e.min);
    if (e.max !== undefined) max = max === undefined ? e.max : Math.max(max, e.max);
  }
  const buckets = mergeBuckets(list.map((e) => e.buckets));
  return { p50: quantileFromBuckets(buckets, 0.5, min, max), p95: quantileFromBuckets(buckets, 0.95, min, max), n };
}

function worstOf(e: EpochStats): FindingSeverity | undefined {
  let worst: FindingSeverity | undefined;
  for (const f of e.findings) worst = worseSeverity(worst, f.severity);
  return worst;
}

function ioOf(e: EpochStats): number | undefined {
  return e.io ? e.io.db + e.io.cache + e.io.fetch : undefined;
}

/** Server rows that feed the stats: like the client's isCountable, static assets stay out. */
export function countableRoutes(s: StatsResponse): ServerRouteStats[] {
  return s.routes.filter((r) => r.kind !== "asset");
}

/**
 * Server route rows in the client RouteStats shape. `lastTraceIds` maps a route key to its newest
 * retained trace (client side); an evicted route gets "" and the UI offers a filter instead.
 */
export function serverRouteStats(s: StatsResponse, lastTraceIds: ReadonlyMap<string, string>): RouteStats[] {
  return countableRoutes(s).map((r) => {
    const a = r.all;
    return {
      key: r.key,
      method: r.method,
      route: r.route,
      hits: a.count,
      errors: a.errors,
      errPct: a.count > 0 ? (a.errors / a.count) * 100 : 0,
      latency: { p50: a.p50, p95: a.p95, n: a.warm },
      coldHits: a.cold,
      mix: a.time as Record<TimeBucket, number> | undefined,
      avgIo: ioOf(a),
      findings: a.findings.length,
      worstSeverity: worstOf(a),
      lastAt: r.lastSeen,
      lastTraceId: lastTraceIds.get(r.key) ?? "",
    };
  });
}

/** KPI tiles from the server aggregates; findings counts come from the client's grouped findings. */
export function serverKpis(s: StatsResponse, openFindings: number, newFindings: number): Kpis {
  const routes = countableRoutes(s);
  let requests = 0;
  let errors = 0;
  let cold = 0;
  let ioSum = 0;
  let ioW = 0;
  for (const r of routes) {
    requests += r.all.count;
    errors += r.all.errors;
    cold += r.all.cold;
    const io = ioOf(r.all);
    if (io !== undefined) {
      ioSum += io * r.all.count;
      ioW += r.all.count;
    }
  }
  return {
    requests,
    latency: mergedPercentiles(routes.map((r) => r.all)),
    coldExcluded: cold,
    errors,
    errPct: requests > 0 ? (errors / requests) * 100 : undefined,
    openFindings,
    newFindings,
    avgIo: ioW > 0 ? ioSum / ioW : undefined,
  };
}

/** Sidebar badges keyed by route template, all methods together (matches RouteInfo.nextRoute). */
export function serverRouteBadges(s: StatsResponse): Map<string, RouteBadge> {
  const groups = new Map<string, ServerRouteStats[]>();
  for (const r of countableRoutes(s)) {
    const list = groups.get(r.route);
    if (list) list.push(r);
    else groups.set(r.route, [r]);
  }
  const out = new Map<string, RouteBadge>();
  for (const [k, list] of groups) {
    const fps = new Set<string>();
    let worst: FindingSeverity | undefined;
    let hits = 0;
    for (const r of list) {
      hits += r.all.count;
      for (const f of r.all.findings) {
        fps.add(f.fingerprint);
        worst = worseSeverity(worst, f.severity);
      }
    }
    out.set(k, { hits, latency: mergedPercentiles(list.map((r) => r.all)), findings: fps.size, worstSeverity: worst });
  }
  return out;
}

/** Warm percentiles per server route key ("GET /api/x"), for scaling the request log's duration bars. */
export function serverLatencyByKey(s: StatsResponse): Map<string, Percentiles> {
  const out = new Map<string, Percentiles>();
  for (const r of s.routes) out.set(r.key, { p50: r.all.p50, p95: r.all.p95, n: r.all.warm });
  return out;
}
