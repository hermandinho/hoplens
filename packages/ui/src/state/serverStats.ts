import { batch, effect, signal } from "@preact/signals";
import { HoplensApiError, api } from "../api/client";
import type {
  EpochStats,
  FindingRollup,
  FindingSeverity,
  HistogramBucket,
  ServerRouteStats,
  StatsResponse,
  TimeBucket,
} from "../api/types";
import { clearedAt, liveActivity, throttle } from "./activity";
import { route } from "./router";
import {
  type ErrorTally,
  type FindingGroup,
  type Kpis,
  type Percentiles,
  type RouteBadge,
  type RouteStats,
  rankFindingGroups,
  worseSeverity,
} from "./stats";

/*
 * Server-side route stats (GET /api/stats?buckets=1). They survive ring-buffer eviction and are
 * kept per dev-rebuild epoch; cold requests are always out of the server's histograms. The store
 * prefers them over the client-side reduction while "Include cold" is off, and falls back to the
 * client stats when the endpoint is missing (older core), failing, or cold requests are wanted.
 */

export type ServerStatsState = "idle" | "loading" | "ready" | "error" | "unavailable";

export const serverStats = signal<StatsResponse | null>(null);
export const serverStatsState = signal<ServerStatsState>("idle");

/**
 * The core's own scoped snapshot (GET /api/stats?since=<epoch>, r4) for the route's since scope.
 * null when the scope is off, the core predates the parameter, or the last scoped fetch failed
 * (then `sinceScope` merges the unscoped snapshot's per-epoch stats itself).
 */
export const scopedServerStats = signal<StatsResponse | null>(null);
/** Feature detection: false once a core answered a `?since=` request without `scope`. */
let sinceSupported = true;

function scopeEpoch(): number | undefined {
  const s = route.peek().since;
  if (s === undefined || s === "") return undefined;
  const n = Number(s.split(":").pop());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The server's scoped stats for `since` when the core answered that exact scope, else null (the
 * caller falls back to merging epochs client-side). Pure.
 */
export function coreScopedStats(
  scoped: StatsResponse | null,
  since: number,
): { stats: StatsResponse; partial: boolean } | null {
  const sc = scoped?.scope;
  if (!scoped || !sc || sc.sinceEpoch !== since) return null;
  return { stats: scoped, partial: sc.partial };
}

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
  // With a since scope on, ask the core for its own scoped snapshot alongside (best effort).
  const since = sinceSupported ? scopeEpoch() : undefined;
  const scopedReq = since === undefined ? null : api.stats(true, since).catch(() => null);
  try {
    const s = await api.stats(true);
    const scoped = scopedReq ? await scopedReq : null;
    batch(() => {
      serverStats.value = s;
      serverStatsState.value = "ready";
      if (since === undefined) scopedServerStats.value = null;
      else if (scoped) {
        // A core that ignores `?since=` answers without `scope`: stop asking, the UI merges per epoch.
        if (!scoped.scope) sinceSupported = false;
        scopedServerStats.value = scoped.scope ? scoped : null;
      }
    });
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
  scopedServerStats.value = null;
});
// A new since scope: fetch its scoped snapshot now rather than at the next request.
effect(() => {
  const since = route.value.since;
  if (since === undefined) {
    scopedServerStats.value = null;
    return;
  }
  if (sinceSupported && serverStats.peek()) scheduleStatsRefresh();
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
      totalMs: (a.avg ?? 0) * a.warm,
      delta: r.delta,
      exemplars: r.exemplars,
    };
  });
}

/** The errors line from the server's totals; undefined from a core without the split (fall back to the tab). */
export function serverErrorTally(s: StatsResponse): ErrorTally | undefined {
  let fivexx = 0;
  let thrown = 0;
  let swallowed = 0;
  for (const r of countableRoutes(s)) {
    const k = r.all.errorKinds;
    if (!k) return undefined;
    fivexx += k.fivexx;
    thrown += k.thrown;
    swallowed += k.swallowed;
  }
  return { fivexx, thrown, swallowed, total: fivexx + thrown + swallowed };
}

/**
 * Overview findings: the server rollup (it survives ring eviction, so its counts are the honest ones)
 * joined with the tab's groups by fingerprint. A retained example request is taken from the tab
 * first, else the server's newest one if `retained` still has it, else "" (filter only). Tab-only
 * fingerprints (past the server's per-route cap) are kept. Without a rollup, the tab's groups as is.
 */
export function mergeFindingGroups(
  client: readonly FindingGroup[],
  server: readonly FindingRollup[] | undefined,
  retained: (traceId: string) => boolean,
): FindingGroup[] {
  if (!server) return [...client];
  const byFp = new Map(client.map((g) => [g.fingerprint, g]));
  const out: FindingGroup[] = [];
  for (const f of server) {
    const c = byFp.get(f.fingerprint);
    byFp.delete(f.fingerprint);
    const requests = Math.max(f.requests, c?.requests ?? 0);
    const per = f.savedMsPerRequest ?? c?.savedMsPerRequest;
    out.push({
      fingerprint: f.fingerprint,
      rule: f.rule,
      severity: worseSeverity(c?.severity, f.severity),
      title: c?.title ?? f.title,
      fn: c?.fn ?? f.fn,
      location: c?.location ?? f.location,
      requests,
      maxCount: Math.max(f.maxCount ?? 0, c?.maxCount ?? 0) || undefined,
      worstSavedMs: c?.worstSavedMs,
      savedMsPerRequest: per,
      impactMs: per === undefined ? 0 : per * requests,
      seenOnce: requests === 1,
      routes: [...new Set([...f.routes, ...(c?.routes ?? [])])],
      latestTraceId: c?.latestTraceId || (f.lastTraceId && retained(f.lastTraceId) ? f.lastTraceId : ""),
      latestAt: Math.max(f.lastSeen, c?.latestAt ?? 0),
      firstAt: c?.firstAt ?? f.lastSeen,
      isNew: c?.isNew ?? false,
      lastEpoch: Math.max(f.lastEpoch, c?.lastEpoch ?? Number.NEGATIVE_INFINITY),
    });
  }
  for (const c of byFp.values()) out.push(c);
  return rankFindingGroups(out);
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
