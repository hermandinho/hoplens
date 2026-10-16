import type { FindingRule, FindingSeverity, RouteEpochDelta, TimeBucket, TraceSummary } from "../api/types";

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
  /** Time spent: summed duration of the requests behind `latency` (ms). */
  totalMs: number;
  /** Server only: newest epoch vs the route's previous one (the d-epoch column). */
  delta?: RouteEpochDelta;
  /** Server only: fast / typical / slow example requests (may have left the ring since). */
  exemplars?: Exemplars;
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
    const durations = warmDurations(list, includeCold);
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
      latency: percentiles(durations),
      totalMs: durations.reduce((a, b) => a + b, 0),
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

export type RouteSort = "time" | "p95" | "hits" | "errors";

/**
 * Sort descending by the chosen metric; ties fall back to hits, then key for stability. "time" =
 * time spent (summed duration), the Overview default: a fast route hit 500 times can matter more
 * than a slow one hit once.
 */
export function sortRouteStats(list: readonly RouteStats[], by: RouteSort): RouteStats[] {
  const metric = (r: RouteStats): number =>
    by === "time"
      ? r.totalMs
      : by === "p95"
        ? (r.latency.p95 ?? -1)
        : by === "hits"
          ? r.hits
          : r.errors * 1e6 + r.errPct;
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
  /** Mean per-request saving estimate (ms) over the requests that had one. "~173ms per request". */
  savedMsPerRequest?: number;
  /** savedMsPerRequest x requests: the total over the requests seen ("= 1.6s"). 0 without an estimate. */
  impactMs: number;
  /** Seen in exactly one request: ranked after every repeatable finding, labelled "seen once". */
  seenOnce: boolean;
  /** Route keys ("GET /api/feed"). */
  routes: string[];
  /** Newest retained request with this finding; "" when every one was evicted (server-only rows). */
  latestTraceId: string;
  latestAt: number;
  firstAt: number;
  /** First seen in the newest dev-rebuild epoch while older epochs exist. */
  isNew: boolean;
}

/**
 * Low-signal findings sink below every actionable one and never become the hero: seen in a single
 * request, or a dev compile stall (cold-compile: the dev server's cost, not the code's). Mirrors core.
 */
export function isLowSignal(f: Pick<FindingGroup, "seenOnce" | "rule">): boolean {
  return f.seenOnce || f.rule === "cold-compile";
}

/**
 * Overview order (plan 3.1 #3, mirrors core `rankFindings`): actionable findings before low-signal
 * ones (`isLowSignal`), then impact (saveable ms x requests), severity, requests, recency, fingerprint.
 */
export function rankFindingGroups<
  T extends Pick<FindingGroup, "impactMs" | "seenOnce" | "rule" | "severity" | "requests" | "latestAt" | "fingerprint">,
>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(isLowSignal(a)) - Number(isLowSignal(b)) ||
      b.impactMs - a.impactMs ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.requests - a.requests ||
      b.latestAt - a.latestAt ||
      (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0),
  );
}

/**
 * Group findings across all traces by fingerprint, ranked by `rankFindingGroups`. "New" means first
 * seen in the newest epoch, and is only claimed when the retained traces span more than one epoch
 * (otherwise everything would be "new").
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

  type Acc = FindingGroup & { routeSet: Set<string>; firstEpoch: number; savedSum: number; savedN: number };
  const groups = new Map<string, Acc>();
  for (const t of traces) {
    if (!t.findings?.length) continue;
    const epoch = t.facts?.epoch ?? Number.NEGATIVE_INFINITY;
    // A trace can carry the same fingerprint twice (e.g. request and response payload findings):
    // count the request once, with the larger saving.
    const savedHere = new Map<string, number | undefined>();
    for (const f of t.findings) {
      const prev = savedHere.get(f.fingerprint);
      const cur = f.estSavedMs !== undefined && Number.isFinite(f.estSavedMs) ? f.estSavedMs : undefined;
      savedHere.set(f.fingerprint, cur === undefined ? prev : Math.max(prev ?? 0, cur));
    }
    for (const [fp, saved] of savedHere) {
      if (saved === undefined) continue;
      const g = groups.get(fp);
      if (g) {
        g.savedSum += saved;
        g.savedN++;
      }
    }
    const seen = new Set<string>();
    for (const f of t.findings) {
      const g = groups.get(f.fingerprint);
      const firstInTrace = !seen.has(f.fingerprint);
      seen.add(f.fingerprint);
      if (!g) {
        const saved = savedHere.get(f.fingerprint);
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
          impactMs: 0,
          seenOnce: false,
          routes: [],
          routeSet: new Set([routeKeyOf(t)]),
          latestTraceId: t.id,
          latestAt: t.startedAt,
          firstAt: t.startedAt,
          firstEpoch: epoch,
          isNew: false,
          savedSum: saved ?? 0,
          savedN: saved === undefined ? 0 : 1,
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
  for (const { routeSet, firstEpoch, savedSum, savedN, ...g } of groups.values()) {
    const per = savedN > 0 ? savedSum / savedN : undefined;
    out.push({
      ...g,
      routes: [...routeSet],
      isNew: multiEpoch && firstEpoch === maxEpoch,
      savedMsPerRequest: per,
      impactMs: per === undefined ? 0 : per * g.requests,
      seenOnce: g.requests === 1,
    });
  }
  return rankFindingGroups(out);
}

/* ------------------------------------------------------------- errors tally */

/**
 * The Overview's errors line (plan 3.3): one honest number, split three ways, disjoint.
 *   fivexx     answered >= 500 with no exception captured (the route returned the error itself)
 *   thrown     failed (>= 500, or no status) with an exception captured
 *   swallowed  answered below 500 although an exception was captured (isHandledError)
 * Mirrors core's ErrorKinds.
 */
export interface ErrorTally {
  fivexx: number;
  thrown: number;
  swallowed: number;
  total: number;
}

export function errorTally(traces: readonly TraceSummary[]): ErrorTally {
  const out: ErrorTally = { fivexx: 0, thrown: 0, swallowed: 0, total: 0 };
  for (const t of traces) {
    if (!isCountable(t)) continue;
    if (isError(t)) {
      if (t.error) out.thrown++;
      else out.fivexx++;
    } else if (isHandledError(t)) out.swallowed++;
  }
  out.total = out.fivexx + out.thrown + out.swallowed;
  return out;
}

/**
 * Request-log queries for the errors line, matching `errorTally` exactly (r2: "thrown" also counts a
 * request that threw before it had a status, which `status:5xx has:error` never matched).
 * `-status:<500` keeps 5xx and status-less requests. thrown = isError with an error; fivexx = 5xx
 * with none; swallowed = isHandledError.
 */
export const ERROR_QUERIES = {
  fivexx: "status:5xx -has:error",
  thrown: "has:error -status:<500",
  swallowed: "has:error status:<500",
} as const;

/**
 * The query for "list the failed ones" (5xx and thrown together) or the swallowed ones, whichever
 * is larger. The language has no OR across keys, so a mix of 5xx and thrown uses `-status:<500`,
 * which can also list a request still in flight.
 */
export function errorQueryFor(e: ErrorTally): string {
  if (e.swallowed >= e.fivexx + e.thrown) return ERROR_QUERIES.swallowed;
  if (e.thrown === 0) return ERROR_QUERIES.fivexx;
  if (e.fivexx === 0) return ERROR_QUERIES.thrown;
  return "-status:<500";
}

/* ---------------------------------------------------------------- exemplars */

export interface ExemplarPick {
  traceId: string;
  ms: number;
}

export interface Exemplars {
  fast: ExemplarPick;
  typical: ExemplarPick;
  slow: ExemplarPick;
  /** Requests the three were picked from. */
  n: number;
}

/**
 * fast = the p10 request, typical = the one closest to the p50, slow = the slowest; ties go to the
 * later sample. Same rule as core `pickExemplars`. Undefined for an empty list.
 */
export function pickExemplars(samples: readonly ExemplarPick[]): Exemplars | undefined {
  const n = samples.length;
  if (n === 0) return undefined;
  const sorted = samples.map((e, i) => ({ e, i })).sort((a, b) => a.e.ms - b.e.ms || a.i - b.i);
  const mid = (n - 1) / 2;
  const p50 =
    ((sorted[Math.floor(mid)] as { e: ExemplarPick }).e.ms + (sorted[Math.ceil(mid)] as { e: ExemplarPick }).e.ms) / 2;
  let typical = sorted[0] as { e: ExemplarPick; i: number };
  for (const x of sorted) {
    const d = Math.abs(x.e.ms - p50);
    const best = Math.abs(typical.e.ms - p50);
    if (d < best || (d === best && x.i > typical.i)) typical = x;
  }
  const fast = (sorted[Math.round(0.1 * (n - 1))] as { e: ExemplarPick }).e;
  return { fast, typical: typical.e, slow: (sorted[n - 1] as { e: ExemplarPick }).e, n };
}

/** Exemplars over one route's retained warm requests (cold ones too when `includeCold`), oldest first. */
export function routeExemplars(
  traces: readonly TraceSummary[],
  routeKey: string,
  includeCold: boolean,
): Exemplars | undefined {
  const list = traces
    .filter((t) => isCountable(t) && t.duration !== undefined && routeKeyOf(t) === routeKey)
    .filter((t) => includeCold || !isCold(t))
    .sort((a, b) => a.startedAt - b.startedAt);
  // Examples of the route working: a 500 that answered in 1ms is not its "fast" run (r2; mirrors
  // core). Only when every request failed are the failures the examples.
  const ok = list.filter((t) => !isError(t) && !t.error);
  return pickExemplars((ok.length ? ok : list).map((t) => ({ traceId: t.id, ms: t.duration as number })));
}

/* ------------------------------------------------------------- stable order */

/**
 * Keep the order the reader is looking at (plan 3.1 #5): `prev` is the key order on screen when the
 * hold began. Keys still present keep that order; new keys follow in `next`'s order. Without a
 * previous order, `next` as is.
 */
export function holdOrder<T>(prev: readonly string[] | null, next: readonly T[], key: (x: T) => string): T[] {
  if (!prev) return [...next];
  const at = new Map(prev.map((k, i) => [k, i]));
  const kept: T[] = [];
  const fresh: T[] = [];
  for (const x of next) (at.has(key(x)) ? kept : fresh).push(x);
  kept.sort((a, b) => (at.get(key(a)) as number) - (at.get(key(b)) as number));
  return [...kept, ...fresh];
}

/* --------------------------------------------------------------------- hero */

export type HeroKind = "finding" | "errors" | "clean" | "empty";

export interface Hero {
  kind: HeroKind;
  /** The finding the hero names (kind "finding"). */
  finding?: FindingGroup;
  /** Route keys the finding was seen on, or the route the "clean" sentence names. */
  routes: string[];
  /** Low-signal findings (seen once, dev compile; never the hero), for the "no repeatable problems" sentence. */
  seenOnce: number;
  requests: number;
  errors?: ErrorTally;
  slowest?: { key: string; p50?: number; n: number };
}

/** A finding below this saving per request never becomes the hero (same floor as the trace verdict). */
export const HERO_MIN_SAVE_MS = 10;

/**
 * Overview hero (plan 3.3): the #1 repeatable finding by impact when it saves >= 10ms a request;
 * else the errors, when anything failed or was swallowed; else "no problems" with the slowest route.
 * `findings` must already be ranked.
 */
export function overviewHero(
  findings: readonly FindingGroup[],
  routes: readonly RouteStats[],
  errors: ErrorTally,
  requests: number,
): Hero {
  const seenOnce = findings.filter(isLowSignal).length;
  if (requests === 0) return { kind: "empty", routes: [], seenOnce, requests };
  const top = findings.find(
    (f) => !isLowSignal(f) && f.savedMsPerRequest !== undefined && f.savedMsPerRequest >= HERO_MIN_SAVE_MS,
  );
  if (top) return { kind: "finding", finding: top, routes: top.routes, seenOnce, requests };
  if (errors.total > 0) return { kind: "errors", routes: [], seenOnce, requests, errors };
  let slowest: RouteStats | undefined;
  for (const r of routes) if (r.latency.p50 !== undefined && (slowest?.latency.p50 ?? -1) < r.latency.p50) slowest = r;
  return {
    kind: "clean",
    routes: slowest ? [slowest.key] : [],
    seenOnce,
    requests,
    slowest: slowest ? { key: slowest.key, p50: slowest.latency.p50, n: slowest.latency.n } : undefined,
  };
}

/** "GET /api/feed" -> "/api/feed" for prose; anything without a method is returned as is. */
export function routeOfKey(key: string): string {
  const sp = key.indexOf(" ");
  return sp > 0 && /^[A-Z]+$/.test(key.slice(0, sp)) ? key.slice(sp + 1) : key;
}

/* ------------------------------------------------------------ epoch delta */

/** Delta label for the d-epoch column: "+84" / "-12" / "=" ms; undefined = blank (n < 3 or no data). */
export function deltaLabel(d: RouteEpochDelta | undefined): string | undefined {
  if (!d || d.status === "insufficient" || d.status === "no-traffic" || d.deltaMs === undefined) return undefined;
  if (d.status === "unchanged") return "=";
  const v = Math.round(d.deltaMs);
  return v > 0 ? `+${v}` : `${v}`;
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

/* ---------------------------------------------------------------- formatting */

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  // Thresholds on the rounded value, so 999.6 reads "1.00s", not "1000ms" (and 9.96 "10ms").
  if (ms >= 9_995) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 999.5) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 9.95) return `${Math.round(ms)}ms`;
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
