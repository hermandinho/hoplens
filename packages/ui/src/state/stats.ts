import type { FindingRule, FindingSeverity, TimeBucket, TraceSummary } from "../api/types";

/*
 * Cross-request statistics, computed client-side from TraceSummary[] (the SSE + /traces feed).
 * Every function here is pure: no signals, no DOM, no Date.now() — callers pass whatever they need.
 * That keeps them trivially unit-testable once the UI package grows a test runner.
 */

/** Bucket order used by every stacked bar and legend in the UI. */
export const BUCKETS: readonly TimeBucket[] = ["db", "cache", "ext", "fn", "framework", "compile", "idle"];

export const BUCKET_LABELS: Record<TimeBucket, string> = {
  db: "db",
  cache: "cache",
  ext: "external",
  fn: "your code",
  framework: "framework",
  compile: "compile",
  idle: "idle",
};

export const RULE_LABELS: Record<FindingRule, string> = {
  "n-plus-1": "N+1",
  duplicate: "duplicate",
  parallelizable: "parallelizable",
  "slow-fn": "slow function",
  "fetch-uncached": "uncached fetch",
  "cold-compile": "cold compile",
  "large-payload": "large payload",
  "swallowed-error": "swallowed error",
  "logs-on-success": "logs on success",
};

/** Below this many samples a percentile is shown greyed with a "~" prefix. */
export const SMALL_SAMPLE = 10;

const SEVERITY_RANK: Record<FindingSeverity, number> = { info: 0, warn: 1, error: 2 };

export function worseSeverity(a: FindingSeverity | undefined, b: FindingSeverity): FindingSeverity {
  return a === undefined || SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/**
 * Quantile with linear interpolation between closest ranks (the "R-7" / Excel PERCENTILE.INC
 * definition). `sorted` must be ascending. Returns undefined for an empty input.
 */
export function quantile(sorted: readonly number[], q: number): number | undefined {
  const n = sorted.length;
  if (n === 0) return undefined;
  if (n === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, q));
  const pos = (n - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export interface Percentiles {
  p50?: number;
  p95?: number;
  /** Sample count the percentiles were computed from. */
  n: number;
}

export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), n: sorted.length };
}

/* ------------------------------------------------------------- classification */

/** Traces that feed the stats: finished, and not static assets. */
export function isCountable(t: TraceSummary): boolean {
  return t.done && t.kind !== "asset";
}

export function isCold(t: TraceSummary): boolean {
  return t.facts?.cold === true;
}

/**
 * A server-side failure: a 5xx (a thrown route error lands here too). 4xx is the client's problem,
 * and an error caught inside a 2xx request is a swallowed-error finding, not a failed request.
 * A trace with an error and no status at all (connection dropped) still counts.
 */
export function isError(t: Pick<TraceSummary, "error" | "status">): boolean {
  return (t.status ?? 0) >= 500 || (Boolean(t.error) && t.status === undefined);
}

/** Status badge class: the HTTP status decides the colour; a caught error doesn't turn a 200 red. */
export function statusClass(t: { error?: unknown; status?: number }): string {
  if (t.status === undefined) return t.error ? "c5" : "c0";
  return `c${Math.floor(t.status / 100)}`;
}

/** An error was recorded but the response still went out below 500: the route caught it. */
export function isHandledError(t: { error?: unknown; status?: number }): boolean {
  return Boolean(t.error) && t.status !== undefined && t.status < 500;
}

/** Outgoing I/O per request: db queries + cache calls + fetches. */
export function ioCount(t: TraceSummary): number | undefined {
  const c = t.facts?.counts;
  return c ? c.db + c.cache + c.fetch : undefined;
}

/** "GET /api/products/[id]" — groups traces by route template when Next reported one. */
export function routeKeyOf(t: Pick<TraceSummary, "method" | "route" | "path">): string {
  return `${t.method} ${t.route ?? t.path}`;
}

/** Durations eligible for percentiles: cold requests are excluded unless `includeCold`. */
export function warmDurations(traces: readonly TraceSummary[], includeCold: boolean): number[] {
  const out: number[] = [];
  for (const t of traces) {
    if (t.duration === undefined || !isCountable(t)) continue;
    if (!includeCold && isCold(t)) continue;
    out.push(t.duration);
  }
  return out;
}

/** Sum time per bucket across traces that carry facts. Returns undefined when none do. */
export function timeMix(traces: readonly TraceSummary[]): Record<TimeBucket, number> | undefined {
  const acc: Record<TimeBucket, number> = { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 };
  let any = false;
  for (const t of traces) {
    const time = t.facts?.time;
    if (!time) continue;
    any = true;
    for (const b of BUCKETS) acc[b] += time[b] ?? 0;
  }
  return any ? acc : undefined;
}

/* -------------------------------------------------------------------- routes */

export interface RouteStats {
  key: string;
  method: string;
  /** Route template when known, else the concrete path. */
  route: string;
  hits: number;
  errors: number;
  /** 0..100 */
  errPct: number;
  /** Percentiles over warm (or all, per toggle) durations. */
  latency: Percentiles;
  coldHits: number;
  mix?: Record<TimeBucket, number>;
  /** Mean db + cache + fetch calls per request with facts. */
  avgIo?: number;
  /** Distinct finding fingerprints seen on this route. */
  findings: number;
  worstSeverity?: FindingSeverity;
  lastAt: number;
  lastTraceId: string;
}

export function computeRouteStats(traces: readonly TraceSummary[], includeCold: boolean): RouteStats[] {
  const groups = new Map<string, TraceSummary[]>();
  for (const t of traces) {
    if (!isCountable(t)) continue;
    const k = routeKeyOf(t);
    const list = groups.get(k);
    if (list) list.push(t);
    else groups.set(k, [t]);
  }
  const out: RouteStats[] = [];
  for (const [key, list] of groups) {
    const first = list[0] as TraceSummary;
    let errors = 0;
    let coldHits = 0;
    let ioSum = 0;
    let ioN = 0;
    let lastAt = Number.NEGATIVE_INFINITY;
    let lastTraceId = first.id;
    let worst: FindingSeverity | undefined;
    const fps = new Set<string>();
    for (const t of list) {
      if (isError(t)) errors++;
      if (isCold(t)) coldHits++;
      const io = ioCount(t);
      if (io !== undefined) {
        ioSum += io;
        ioN++;
      }
      if (t.startedAt > lastAt) {
        lastAt = t.startedAt;
        lastTraceId = t.id;
      }
      for (const f of t.findings ?? []) {
        fps.add(f.fingerprint);
        worst = worseSeverity(worst, f.severity);
      }
    }
    out.push({
      key,
      method: first.method,
      route: first.route ?? first.path,
      hits: list.length,
      errors,
      errPct: (errors / list.length) * 100,
      latency: percentiles(warmDurations(list, includeCold)),
      coldHits,
      mix: timeMix(list),
      avgIo: ioN > 0 ? ioSum / ioN : undefined,
      findings: fps.size,
      worstSeverity: worst,
      lastAt,
      lastTraceId,
    });
  }
  return out;
}

export type RouteSort = "p95" | "hits" | "errors";

/** Sort descending by the chosen metric; ties fall back to hits, then key for stability. */
export function sortRouteStats(list: readonly RouteStats[], by: RouteSort): RouteStats[] {
  const metric = (r: RouteStats): number =>
    by === "p95" ? (r.latency.p95 ?? -1) : by === "hits" ? r.hits : r.errors * 1e6 + r.errPct;
  return [...list].sort((a, b) => metric(b) - metric(a) || b.hits - a.hits || a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ findings */

export interface FindingGroup {
  fingerprint: string;
  rule: FindingRule;
  severity: FindingSeverity;
  /** Title from the most recent occurrence. */
  title: string;
  fn?: string;
  location?: { file: string; line: number; column?: number };
  /** Number of requests that hit this finding. */
  requests: number;
  /** Largest per-request count (e.g. N in N+1). */
  maxCount?: number;
  worstSavedMs?: number;
  routes: string[];
  latestTraceId: string;
  latestAt: number;
  firstAt: number;
  /** First seen in the newest dev-rebuild epoch while older epochs exist. */
  isNew: boolean;
}

/**
 * Group findings across all traces by fingerprint. Sorted by severity, then estimated savings,
 * then affected request count. "New" means first seen in the newest epoch, and is only claimed
 * when the retained traces span more than one epoch (otherwise everything would be "new").
 */
export function groupFindings(traces: readonly TraceSummary[]): FindingGroup[] {
  let maxEpoch = Number.NEGATIVE_INFINITY;
  let minEpoch = Number.POSITIVE_INFINITY;
  for (const t of traces) {
    const e = t.facts?.epoch;
    if (e === undefined) continue;
    if (e > maxEpoch) maxEpoch = e;
    if (e < minEpoch) minEpoch = e;
  }
  const multiEpoch = maxEpoch > minEpoch;

  const groups = new Map<string, FindingGroup & { routeSet: Set<string>; firstEpoch: number }>();
  for (const t of traces) {
    if (!t.findings?.length) continue;
    const epoch = t.facts?.epoch ?? Number.NEGATIVE_INFINITY;
    const seen = new Set<string>();
    for (const f of t.findings) {
      const g = groups.get(f.fingerprint);
      // A trace can carry the same fingerprint twice (e.g. two request/response payload findings);
      // count the request once.
      const firstInTrace = !seen.has(f.fingerprint);
      seen.add(f.fingerprint);
      if (!g) {
        groups.set(f.fingerprint, {
          fingerprint: f.fingerprint,
          rule: f.rule,
          severity: f.severity,
          title: f.title,
          fn: f.fn,
          location: f.location,
          requests: 1,
          maxCount: f.count,
          worstSavedMs: f.estSavedMs,
          routes: [],
          routeSet: new Set([routeKeyOf(t)]),
          latestTraceId: t.id,
          latestAt: t.startedAt,
          firstAt: t.startedAt,
          firstEpoch: epoch,
          isNew: false,
        });
        continue;
      }
      if (firstInTrace) g.requests++;
      g.severity = worseSeverity(g.severity, f.severity);
      if (f.count !== undefined) g.maxCount = Math.max(g.maxCount ?? 0, f.count);
      if (f.estSavedMs !== undefined) g.worstSavedMs = Math.max(g.worstSavedMs ?? 0, f.estSavedMs);
      g.routeSet.add(routeKeyOf(t));
      if (t.startedAt >= g.latestAt) {
        g.latestAt = t.startedAt;
        g.latestTraceId = t.id;
        g.title = f.title;
        if (f.fn) g.fn = f.fn;
        if (f.location) g.location = f.location;
      }
      if (t.startedAt < g.firstAt) g.firstAt = t.startedAt;
      if (epoch < g.firstEpoch) g.firstEpoch = epoch;
    }
  }

  const out: FindingGroup[] = [];
  for (const { routeSet, firstEpoch, ...g } of groups.values()) {
    out.push({ ...g, routes: [...routeSet], isNew: multiEpoch && firstEpoch === maxEpoch });
  }
  return out.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.worstSavedMs ?? 0) - (a.worstSavedMs ?? 0) ||
      b.requests - a.requests ||
      b.latestAt - a.latestAt,
  );
}

/** Finding summary per route key, for badges in the sidebar and traffic list. */
export interface RouteBadge {
  hits: number;
  latency: Percentiles;
  findings: number;
  worstSeverity?: FindingSeverity;
}

/** Per route template (all methods together), keyed by `route ?? path` — matches RouteInfo.nextRoute. */
export function routeBadges(traces: readonly TraceSummary[], includeCold: boolean): Map<string, RouteBadge> {
  const groups = new Map<string, TraceSummary[]>();
  for (const t of traces) {
    if (!isCountable(t)) continue;
    const k = t.route ?? t.path;
    const list = groups.get(k);
    if (list) list.push(t);
    else groups.set(k, [t]);
  }
  const out = new Map<string, RouteBadge>();
  for (const [k, list] of groups) {
    const fps = new Set<string>();
    let worst: FindingSeverity | undefined;
    for (const t of list) {
      for (const f of t.findings ?? []) {
        fps.add(f.fingerprint);
        worst = worseSeverity(worst, f.severity);
      }
    }
    out.set(k, {
      hits: list.length,
      latency: percentiles(warmDurations(list, includeCold)),
      findings: fps.size,
      worstSeverity: worst,
    });
  }
  return out;
}

/** Worst severity among one trace's findings, if any. */
export function traceSeverity(t: TraceSummary): FindingSeverity | undefined {
  let worst: FindingSeverity | undefined;
  for (const f of t.findings ?? []) worst = worseSeverity(worst, f.severity);
  return worst;
}

/* ---------------------------------------------------------------------- KPIs */

export interface Kpis {
  requests: number;
  latency: Percentiles;
  coldExcluded: number;
  errors: number;
  errPct?: number;
  openFindings: number;
  newFindings: number;
  avgIo?: number;
}

export function computeKpis(
  traces: readonly TraceSummary[],
  includeCold: boolean,
  findings: readonly FindingGroup[],
): Kpis {
  let requests = 0;
  let errors = 0;
  let cold = 0;
  let ioSum = 0;
  let ioN = 0;
  for (const t of traces) {
    if (!isCountable(t)) continue;
    requests++;
    if (isError(t)) errors++;
    if (isCold(t)) cold++;
    const io = ioCount(t);
    if (io !== undefined) {
      ioSum += io;
      ioN++;
    }
  }
  return {
    requests,
    latency: percentiles(warmDurations(traces, includeCold)),
    coldExcluded: includeCold ? 0 : cold,
    errors,
    errPct: requests > 0 ? (errors / requests) * 100 : undefined,
    openFindings: findings.length,
    newFindings: findings.filter((f) => f.isNew).length,
    avgIo: ioN > 0 ? ioSum / ioN : undefined,
  };
}

/* ---------------------------------------------------------------- sparklines */

export type SparkMetric = "requests" | "p50" | "p95" | "errPct" | "io";

/**
 * Bin countable traces by start time into `bins` equal slices between the oldest and newest
 * trace, and reduce each bin to one value. Empty bins yield `undefined` (a gap) except for
 * "requests", where an empty bin is a real 0. Returns [] when there is nothing to plot.
 */
export function sparkSeries(
  traces: readonly TraceSummary[],
  metric: SparkMetric,
  bins: number,
  includeCold: boolean,
): Array<number | undefined> {
  const pool = traces.filter(isCountable);
  if (pool.length < 2 || bins < 2) return [];
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const t of pool) {
    if (t.startedAt < lo) lo = t.startedAt;
    if (t.startedAt > hi) hi = t.startedAt;
  }
  const span = hi - lo;
  if (span <= 0) return [];
  const buckets: TraceSummary[][] = Array.from({ length: bins }, () => []);
  for (const t of pool) {
    const i = Math.min(bins - 1, Math.floor(((t.startedAt - lo) / span) * bins));
    (buckets[i] as TraceSummary[]).push(t);
  }
  return buckets.map((b) => {
    if (metric === "requests") return b.length;
    if (b.length === 0) return undefined;
    if (metric === "errPct") return (b.filter(isError).length / b.length) * 100;
    if (metric === "io") {
      const vals = b.map(ioCount).filter((v): v is number => v !== undefined);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : undefined;
    }
    const p = percentiles(warmDurations(b, includeCold));
    return metric === "p50" ? p.p50 : p.p95;
  });
}

/* ---------------------------------------------------------------- formatting */

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 10) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

export function fmtPct(p: number | undefined): string {
  if (p === undefined || !Number.isFinite(p)) return "—";
  if (p === 0) return "0%";
  if (p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

/** "~" prefix for small samples so a 3-request p95 doesn't read as gospel. */
export function approx(n: number): string {
  return n > 0 && n < SMALL_SAMPLE ? "~" : "";
}
