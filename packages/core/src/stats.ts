// Server-side rolling aggregates per route (method + route template) and per dev-rebuild epoch, fed
// from the store's `done` event, so the numbers survive ring-buffer eviction. Fixed log-bucket
// histograms instead of a t-digest: a few hundred bytes per route-epoch, mergeable, and exact enough
// for a dev tool (quantiles land within one bucket, ~19% wide, and are interpolated inside it; up to
// HIST_EXACT_MAX samples they are exact).
// Runs after the response finished, never on the request path.

import { TIME_BUCKETS, normalizeUrl } from "./facts";
import { REGRESSION_RULE, type RegressionStatus, compareEpochs } from "./regressions";
import type { Finding, FindingRule, SourceLocation, TimeBucket, TraceKind, TraceRecord } from "./types";

/* -------------------------------------------------------------- histogram */

/** Smallest bucket upper bound (ms). Bucket 0 holds [0, BASE). */
export const HIST_BASE_MS = 0.1;
/** Buckets per doubling. 4 => each bucket is 2^(1/4) ~ 1.19x wider than the previous one. */
export const HIST_PER_OCTAVE = 4;
/** Bucket count. The last bucket is open-ended; with the defaults it starts at ~10 minutes. */
export const HIST_BUCKETS = 92;

// LOW[i] / HIGH[i]: precomputed bucket bounds (ms), so adding a sample costs one log2.
const LOW = new Float64Array(HIST_BUCKETS);
const HIGH = new Float64Array(HIST_BUCKETS);
for (let i = 0; i < HIST_BUCKETS; i++) {
  LOW[i] = i === 0 ? 0 : HIST_BASE_MS * 2 ** ((i - 1) / HIST_PER_OCTAVE);
  HIGH[i] = i === HIST_BUCKETS - 1 ? Number.POSITIVE_INFINITY : HIST_BASE_MS * 2 ** (i / HIST_PER_OCTAVE);
}

/** Lower bound (ms) of bucket `i`. */
export function bucketLow(i: number): number {
  return LOW[Math.max(0, Math.min(HIST_BUCKETS - 1, i))]!;
}

/** Upper bound (ms) of bucket `i` (Infinity for the last one). */
export function bucketHigh(i: number): number {
  return HIGH[Math.max(0, Math.min(HIST_BUCKETS - 1, i))]!;
}

/** Bucket index for a value in ms. Negative / NaN values land in bucket 0. */
export function bucketIndex(ms: number): number {
  if (!(ms >= HIST_BASE_MS)) return 0;
  const i = Math.min(HIST_BUCKETS - 1, Math.floor(HIST_PER_OCTAVE * Math.log2(ms / HIST_BASE_MS)) + 1);
  // Guard against floating-point drift right at a bucket edge.
  if (ms < LOW[i]!) return i - 1;
  if (ms >= HIGH[i]!) return i + 1;
  return i;
}

export interface HistogramBucket {
  /** Inclusive lower bound, ms. */
  lo: number;
  /** Exclusive upper bound, ms (null for the open-ended last bucket). */
  hi: number | null;
  count: number;
}

/**
 * Below this many samples a histogram also keeps the raw values and answers quantiles exactly: with
 * the n=3..30 a dev session produces per route, one ~19% bucket is the whole difference between
 * "regressed" and "unchanged". 32 doubles (256 bytes) at most per histogram.
 */
export const HIST_EXACT_MAX = 32;

export class LogHistogram {
  readonly counts = new Uint32Array(HIST_BUCKETS);
  /** Raw samples while n <= HIST_EXACT_MAX; null once the histogram outgrew it. */
  private samples: number[] | null = [];
  n = 0;
  sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  add(ms: number): void {
    if (!Number.isFinite(ms)) return;
    const v = Math.max(0, ms);
    this.counts[bucketIndex(v)]!++;
    if (this.samples) {
      if (this.samples.length < HIST_EXACT_MAX) this.samples.push(v);
      else this.samples = null;
    }
    this.n++;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  merge(o: LogHistogram): this {
    for (let i = 0; i < HIST_BUCKETS; i++) this.counts[i] = this.counts[i]! + o.counts[i]!;
    this.samples =
      this.samples && o.samples && this.samples.length + o.samples.length <= HIST_EXACT_MAX
        ? this.samples.concat(o.samples)
        : null;
    this.n += o.n;
    this.sum += o.sum;
    if (o.min < this.min) this.min = o.min;
    if (o.max > this.max) this.max = o.max;
    return this;
  }

  /**
   * Nearest-rank quantile (q in [0, 1]), linearly interpolated inside its bucket and clamped to the
   * observed min/max, so a single sample (or identical samples) comes back exactly. Undefined when empty.
   * While the raw samples are kept (n <= HIST_EXACT_MAX) the answer is exact: linear interpolation
   * between order statistics, so the p50 of 5 samples is their median.
   */
  quantile(q: number): number | undefined {
    if (this.n === 0) return undefined;
    if (!(q > 0)) return this.min;
    if (q >= 1) return this.max;
    if (this.samples && this.samples.length === this.n) {
      const sorted = [...this.samples].sort((a, b) => a - b);
      const pos = q * (sorted.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(sorted.length - 1, lo + 1);
      return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
    }
    const rank = Math.min(this.n, Math.max(1, Math.ceil(Math.min(1, Math.max(0, q)) * this.n)));
    let seen = 0;
    for (let i = 0; i < HIST_BUCKETS; i++) {
      const c = this.counts[i]!;
      if (c === 0) continue;
      if (seen + c >= rank) {
        const lo = Math.max(bucketLow(i), this.min);
        const hi = Math.min(bucketHigh(i), this.max);
        const v = hi > lo ? lo + ((hi - lo) * (rank - seen)) / c : lo;
        return Math.min(this.max, Math.max(this.min, v));
      }
      seen += c;
    }
    return this.max;
  }

  mean(): number | undefined {
    return this.n ? this.sum / this.n : undefined;
  }

  /** Non-empty buckets only. */
  buckets(): HistogramBucket[] {
    const out: HistogramBucket[] = [];
    for (let i = 0; i < HIST_BUCKETS; i++) {
      const count = this.counts[i]!;
      if (!count) continue;
      const hi = bucketHigh(i);
      out.push({ lo: round(bucketLow(i)), hi: Number.isFinite(hi) ? round(hi) : null, count });
    }
    return out;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ---------------------------------------------------------- route stats */

export interface StatsOptions {
  /** Routes kept; the least recently seen is dropped past this. Default 500. */
  maxRoutes?: number;
  /** Distinct URL variants (path + query) tracked per route-epoch; later ones are not tracked. Default 20. */
  maxUrlVariants?: number;
  /** Epochs kept per route (newest win). Default 5. */
  maxEpochs?: number;
  /** Distinct finding fingerprints counted per route-epoch. Default 50. */
  maxFindings?: number;
}

export interface FindingCount {
  fingerprint: string;
  rule: FindingRule;
  severity: "info" | "warn" | "error";
  title: string;
  /** Requests that had this finding (a trace carrying the fingerprint twice counts once). */
  count: number;
  /** From the newest occurrence. */
  fn?: string;
  location?: SourceLocation;
  /** Largest per-request count (the N in an N+1). */
  maxCount?: number;
  /** Sum of the per-request saving estimates (ms), over the `savedN` requests that had one. */
  savedMsSum?: number;
  savedN?: number;
  /** Newest request with this finding (it may have left the ring buffer since). */
  lastTraceId?: string;
  lastSeen?: number;
}

/**
 * Failed and quietly failed requests, disjoint, so they add up to one honest "errors" number:
 *   fivexx     answered >= 500 with no exception captured (the route returned the error itself)
 *   thrown     failed (>= 500, or no status) with an exception captured
 *   swallowed  answered below 500 although an exception was captured (caught and hidden)
 * fivexx + thrown = `errors`.
 */
export interface ErrorKinds {
  fivexx: number;
  thrown: number;
  swallowed: number;
}

export interface IoAverages {
  db: number;
  fetch: number;
  cache: number;
  fn: number;
}

/** Aggregates for one route in one epoch (or merged across the kept epochs, see `RouteStats.all`). */
export interface EpochStats {
  /** Dev-rebuild epoch. -1 on `RouteStats.all` (merged). */
  epoch: number;
  /** Finished requests. */
  count: number;
  /** status >= 500, or an error with no status at all (same definition as the UI's Errors KPI). */
  errors: number;
  /** Cold requests (first in epoch or compiled). Excluded from the duration quantiles. */
  cold: number;
  /** count - cold: the sample the quantiles below come from. */
  warm: number;
  /** Warm duration quantiles (ms), from the log histogram. Absent when warm = 0. */
  p50?: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
  /** Average self-time per bucket (ms) over warm requests that have facts. */
  time?: Record<TimeBucket, number>;
  /** Average I/O counts per request (all requests that have facts). */
  io?: IoAverages;
  /** Finding fingerprints seen, most frequent first. */
  findings: FindingCount[];
  /** `errors` split by how they failed, plus the swallowed ones (see ErrorKinds). Always set by this core. */
  errorKinds?: ErrorKinds;
  firstSeen: number;
  lastSeen: number;
  /** Warm duration histogram (non-empty buckets). Only with `GET /api/stats?buckets=1`. */
  buckets?: HistogramBucket[];
  /**
   * Per URL variant (`urlVariantKey`: path + sorted query), so `/api/feed?fast=1` gets its own
   * baseline next to `/api/feed?fast=0`. Most requests first; at most `maxUrlVariants`.
   */
  variants?: UrlVariantStats[];
}

/** Aggregates for one URL variant of a route (see `urlVariantKey`). */
export interface UrlVariantStats {
  /** Path + query with params sorted by key, then value ("/api/feed?fast=1"). */
  url: string;
  count: number;
  /** Requests in the warm sample (count - cold). */
  warm: number;
  /** Warm duration quantiles (ms). Absent when warm = 0. */
  p50?: number;
  p95?: number;
  /** Average self time per bucket (ms) over this variant's warm requests that have facts. */
  time?: Record<TimeBucket, number>;
  /** Average I/O counts per request of this variant. */
  io?: IoAverages;
}

export interface RouteStats {
  /** "GET /api/orders/[id]": method + route template (else the normalized path). */
  key: string;
  method: string;
  route: string;
  kind: TraceKind;
  lastSeen: number;
  /** Newest epoch's numbers. */
  current: EpochStats;
  /** Merged across every kept epoch. */
  all: EpochStats;
  /** Kept epochs, newest first. */
  epochs: EpochStats[];
  /**
   * p50 change in the newest epoch overall against this route's previous epoch (the Overview's
   * "d e7" column). Absent when the route had no traffic in the newest epoch or no earlier epoch is kept.
   */
  delta?: RouteEpochDelta;
  /** One-click example requests: fast (p10), typical (closest to p50), slow (max), warm only. */
  exemplars?: RouteExemplars;
  /**
   * Requests counted in epochs this route no longer keeps (`all` leaves them out). Absent when none:
   * a "since e<n>" scope reaching past the kept epochs is then exact, else a lower bound.
   */
  evicted?: number;
}

export interface RouteEpochDelta {
  /** The newest epoch (the edit being judged). */
  epoch: number;
  /** The earlier epoch it is compared with. */
  baselineEpoch: number;
  /** Same rule as GET /api/regressions; "insufficient" = warm n < 3 on either side (show blank). */
  status: RegressionStatus;
  deltaMs?: number;
  /** 0.34 = +34%. */
  deltaPct?: number;
  nBefore: number;
  nAfter: number;
  lowConfidence: boolean;
  /** "variants": compared over the URL variants both epochs share (see RouteRegression.basis). */
  basis: "variants" | "route";
}

export interface Exemplar {
  traceId: string;
  ms: number;
  epoch: number;
}

export interface RouteExemplars {
  fast: Exemplar;
  typical: Exemplar;
  slow: Exemplar;
  /** Warm requests the three were picked from (the newest EXEMPLAR_RING of the route). */
  n: number;
}

/**
 * One finding across every route and kept epoch, for the Overview's impact ranking (plan 3.1 #3).
 * Saveable is labelled two ways on purpose: `savedMsPerRequest` (what one request would save) and
 * `impactMs` (that times the requests that had it, i.e. the total).
 */
export interface FindingRollup {
  fingerprint: string;
  rule: FindingRule;
  severity: "info" | "warn" | "error";
  title: string;
  fn?: string;
  location?: SourceLocation;
  maxCount?: number;
  /** Requests that had it, across the kept epochs. */
  requests: number;
  /** Route keys it was seen on. */
  routes: string[];
  /** Mean per-request saving estimate (ms); absent when the rule gives none. */
  savedMsPerRequest?: number;
  /** savedMsPerRequest x requests: the total saveable over the requests seen. 0 without an estimate. */
  impactMs: number;
  /** Seen in exactly one request: ranked after every repeatable finding and labelled so. */
  seenOnce: boolean;
  firstEpoch: number;
  lastEpoch: number;
  lastSeen: number;
  lastTraceId?: string;
}

export interface StatsTotals {
  requests: number;
  errors: number;
  cold: number;
  routes: number;
  /** Late spans that landed after their trace finished, summed. */
  droppedSpans: number;
  /** `errors` split by kind, plus swallowed errors (which are not in `errors`). */
  errorKinds: ErrorKinds;
}

export interface StatsResponse {
  routes: RouteStats[];
  totals: StatsTotals;
  /** Newest epoch seen. */
  epoch: number;
  /** epoch ms the aggregates started (process start or last clear). */
  since: number;
  /** Findings rolled up across routes and kept epochs, ranked by `rankFindings`. */
  findings: FindingRollup[];
  /**
   * Present when scoped with `?since=<epoch>`: only epochs >= sinceEpoch are counted. `partial` = a
   * route dropped epochs the scope reaches back into, so the scoped counts are a lower bound.
   */
  scope?: { sinceEpoch: number; partial: boolean };
}

class VariantAgg {
  count = 0;
  readonly hist = new LogHistogram();
  readonly timeSum: Record<TimeBucket, number> = { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 };
  timeN = 0;
  readonly io: IoAverages = { db: 0, fetch: 0, cache: 0, fn: 0 };
  ioN = 0;

  merge(o: VariantAgg): this {
    this.count += o.count;
    this.hist.merge(o.hist);
    for (const k of TIME_BUCKETS) this.timeSum[k] += o.timeSum[k];
    this.timeN += o.timeN;
    addIo(this.io, o.io);
    this.ioN += o.ioN;
    return this;
  }

  toJSON(url: string): UrlVariantStats {
    const out: UrlVariantStats = { url, count: this.count, warm: this.hist.n };
    if (this.hist.n > 0) {
      out.p50 = round(this.hist.quantile(0.5)!);
      out.p95 = round(this.hist.quantile(0.95)!);
    }
    if (this.timeN > 0) out.time = avgTime(this.timeSum, this.timeN);
    if (this.ioN > 0) out.io = avgIo(this.io, this.ioN);
    return out;
  }
}

function addErrorKinds(into: ErrorKinds, o: ErrorKinds): void {
  into.fivexx += o.fivexx;
  into.thrown += o.thrown;
  into.swallowed += o.swallowed;
}

function worseSev(a: FindingCount["severity"], b: FindingCount["severity"]): FindingCount["severity"] {
  const rank = { info: 0, warn: 1, error: 2 } as const;
  return rank[b] > rank[a] ? b : a;
}

/** Fold `o` (the same fingerprint in another epoch) into `into`. */
function mergeFindingCount(into: FindingCount, o: FindingCount): void {
  into.count += o.count;
  if (o.maxCount !== undefined) into.maxCount = Math.max(into.maxCount ?? 0, o.maxCount);
  if (o.savedN) {
    into.savedMsSum = round((into.savedMsSum ?? 0) + (o.savedMsSum ?? 0));
    into.savedN = (into.savedN ?? 0) + o.savedN;
  }
  if ((o.lastSeen ?? 0) >= (into.lastSeen ?? 0)) {
    into.lastSeen = o.lastSeen;
    into.title = o.title;
    if (o.lastTraceId) into.lastTraceId = o.lastTraceId;
    if (o.fn) into.fn = o.fn;
    if (o.location) into.location = o.location;
  }
  into.severity = worseSev(into.severity, o.severity);
}

function addIo(into: IoAverages, o: IoAverages): void {
  into.db += o.db;
  into.fetch += o.fetch;
  into.cache += o.cache;
  into.fn += o.fn;
}

function avgTime(sum: Record<TimeBucket, number>, n: number): Record<TimeBucket, number> {
  const time = {} as Record<TimeBucket, number>;
  for (const k of TIME_BUCKETS) time[k] = round(sum[k] / n);
  return time;
}

function avgIo(sum: IoAverages, n: number): IoAverages {
  return {
    db: round(sum.db / n),
    fetch: round(sum.fetch / n),
    cache: round(sum.cache / n),
    fn: round(sum.fn / n),
  };
}

/** Longest URL variant key kept; longer ones are cut (a giant query string is not a useful key). */
const MAX_URL_KEY = 200;

/**
 * URL variant key: the path plus its query params sorted by key, then value, so `?b=2&a=1` and
 * `?a=1&b=2` share a baseline. Fragment dropped, capped at 200 chars. Mirrored by the UI.
 */
export function urlVariantKey(url: string): string {
  const hashAt = url.indexOf("#");
  const clean = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = clean.indexOf("?");
  let key = clean;
  if (q >= 0) {
    const params = clean
      .slice(q + 1)
      .split("&")
      .filter(Boolean)
      .sort((a, b) => {
        const ka = a.split("=")[0]!;
        const kb = b.split("=")[0]!;
        return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
    key = params.length ? `${clean.slice(0, q)}?${params.join("&")}` : clean.slice(0, q);
  }
  return key.length > MAX_URL_KEY ? key.slice(0, MAX_URL_KEY) : key;
}

class EpochAgg {
  count = 0;
  errors = 0;
  cold = 0;
  readonly errorKinds: ErrorKinds = { fivexx: 0, thrown: 0, swallowed: 0 };
  readonly hist = new LogHistogram();
  readonly timeSum: Record<TimeBucket, number> = { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 };
  timeN = 0;
  readonly io: IoAverages = { db: 0, fetch: 0, cache: 0, fn: 0 };
  ioN = 0;
  readonly findings = new Map<string, FindingCount>();
  /** URL variant key -> aggregates (insertion order; capped by the store). */
  readonly variants = new Map<string, VariantAgg>();
  firstSeen = Number.POSITIVE_INFINITY;
  lastSeen = 0;

  constructor(readonly epoch: number) {}

  merge(o: EpochAgg, maxFindings: number, maxVariants = Number.POSITIVE_INFINITY): this {
    this.count += o.count;
    this.errors += o.errors;
    this.cold += o.cold;
    addErrorKinds(this.errorKinds, o.errorKinds);
    this.hist.merge(o.hist);
    for (const k of TIME_BUCKETS) this.timeSum[k] += o.timeSum[k];
    this.timeN += o.timeN;
    addIo(this.io, o.io);
    this.ioN += o.ioN;
    for (const [fp, f] of o.findings) {
      const mine = this.findings.get(fp);
      if (mine) mergeFindingCount(mine, f);
      else if (this.findings.size < maxFindings) this.findings.set(fp, { ...f });
    }
    for (const [url, v] of o.variants) {
      const mine = this.variants.get(url);
      if (mine) mine.merge(v);
      else if (this.variants.size < maxVariants) this.variants.set(url, new VariantAgg().merge(v));
    }
    this.firstSeen = Math.min(this.firstSeen, o.firstSeen);
    this.lastSeen = Math.max(this.lastSeen, o.lastSeen);
    return this;
  }

  toJSON(withBuckets: boolean): EpochStats {
    const out: EpochStats = {
      epoch: this.epoch,
      count: this.count,
      errors: this.errors,
      cold: this.cold,
      warm: this.hist.n,
      findings: [...this.findings.values()].sort((a, b) => b.count - a.count).map((f) => ({ ...f })),
      errorKinds: { ...this.errorKinds },
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
    };
    if (this.hist.n > 0) {
      out.p50 = round(this.hist.quantile(0.5)!);
      out.p95 = round(this.hist.quantile(0.95)!);
      out.p99 = round(this.hist.quantile(0.99)!);
      out.min = round(this.hist.min);
      out.max = round(this.hist.max);
      out.avg = round(this.hist.mean()!);
    }
    if (this.timeN > 0) out.time = avgTime(this.timeSum, this.timeN);
    if (this.ioN > 0) out.io = avgIo(this.io, this.ioN);
    if (withBuckets) out.buckets = this.hist.buckets();
    if (this.variants.size > 0)
      out.variants = [...this.variants.entries()].map(([url, v]) => v.toJSON(url)).sort((a, b) => b.count - a.count);
    return out;
  }
}

interface RouteEntry {
  key: string;
  method: string;
  route: string;
  kind: TraceKind;
  lastSeen: number;
  /** epoch -> aggregates, in ascending epoch order. */
  epochs: Map<number, EpochAgg>;
  /** Newest warm requests (a ring of EXEMPLAR_RING), for the exemplars. */
  recent: Exemplar[];
  /** Requests counted in epochs no longer kept (or too old to keep). */
  evicted: number;
}

/** Warm requests remembered per route for picking exemplars. */
export const EXEMPLAR_RING = 64;

/**
 * fast = the p10 request, typical = the one closest to the p50, slow = the slowest. Ties go to the
 * newer request (later in `samples`). Undefined for an empty list. Pure; exported for tests.
 */
export function pickExemplars(samples: readonly Exemplar[]): RouteExemplars | undefined {
  const n = samples.length;
  if (n === 0) return undefined;
  // By ms; among equal ms the newer one sorts last.
  const sorted = samples.map((e, i) => ({ e, i })).sort((a, b) => a.e.ms - b.e.ms || a.i - b.i);
  const mid = (n - 1) / 2;
  const p50 = (sorted[Math.floor(mid)]!.e.ms + sorted[Math.ceil(mid)]!.e.ms) / 2;
  let typical = sorted[0]!;
  for (const x of sorted) {
    const d = Math.abs(x.e.ms - p50);
    const best = Math.abs(typical.e.ms - p50);
    if (d < best || (d === best && x.i > typical.i)) typical = x;
  }
  const fast = sorted[Math.round(0.1 * (n - 1))]!.e;
  return { fast, typical: typical.e, slow: sorted[n - 1]!.e, n };
}

/**
 * The newest epoch's p50 against the route's previous epoch: the nearest earlier kept epoch with
 * warm n >= 3, else simply the nearest earlier one (which then reads "insufficient"). Same rule and
 * URL-variant matching as GET /api/regressions, so the Overview column agrees with Changes.
 * `epochs` ascending. Undefined when the route had no traffic in `newestEpoch` or has no earlier
 * epoch. Pure; exported for tests.
 */
export function epochDelta(
  r: Pick<RouteStats, "key" | "method" | "route">,
  epochs: readonly EpochStats[],
  newestEpoch: number,
): RouteEpochDelta | undefined {
  const after = epochs[epochs.length - 1];
  if (!after || after.epoch !== newestEpoch) return undefined;
  const earlier = epochs.slice(0, -1);
  const nearest = earlier[earlier.length - 1];
  if (!nearest) return undefined;
  const before = [...earlier].reverse().find((e) => e.warm >= REGRESSION_RULE.minN) ?? nearest;
  const c = compareEpochs(r, before, after);
  const out: RouteEpochDelta = {
    epoch: after.epoch,
    baselineEpoch: before.epoch,
    status: c.status,
    nBefore: c.before?.n ?? before.warm,
    nAfter: c.after?.n ?? after.warm,
    lowConfidence: c.lowConfidence,
    basis: c.basis,
  };
  if (c.deltaMs !== undefined) out.deltaMs = c.deltaMs;
  if (c.deltaPct !== undefined) out.deltaPct = c.deltaPct;
  return out;
}

/**
 * Low-signal findings sink below every actionable one: seen in a single request, or a dev compile
 * stall (cold-compile: the dev server's cost, not something the code can save).
 */
export function isLowSignal(f: { seenOnce: boolean; rule: FindingRule }): boolean {
  return f.seenOnce || f.rule === "cold-compile";
}

/**
 * Overview order (plan 3.1 #3): repeatable, actionable findings before low-signal ones (see
 * `isLowSignal`), then by impact
 * (saveable ms x requests), then severity, requests, recency, fingerprint. Pure; exported for tests.
 */
export function rankFindings<
  T extends Pick<
    FindingRollup,
    "impactMs" | "seenOnce" | "rule" | "severity" | "requests" | "lastSeen" | "fingerprint"
  >,
>(list: readonly T[]): T[] {
  const sev = { info: 0, warn: 1, error: 2 } as const;
  return [...list].sort(
    (a, b) =>
      Number(isLowSignal(a)) - Number(isLowSignal(b)) ||
      b.impactMs - a.impactMs ||
      sev[b.severity] - sev[a.severity] ||
      b.requests - a.requests ||
      b.lastSeen - a.lastSeen ||
      (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0),
  );
}

/** One row per fingerprint over every route's kept epochs, ranked by `rankFindings`. Pure; exported for tests. */
export function rollupFindings(
  perRoute: ReadonlyArray<{ key: string; epochs: readonly EpochStats[] }>,
): FindingRollup[] {
  const by = new Map<string, FindingRollup & { savedSum: number; savedN: number }>();
  for (const r of perRoute) {
    for (const e of r.epochs) {
      for (const f of e.findings) {
        let g = by.get(f.fingerprint);
        if (!g) {
          g = {
            fingerprint: f.fingerprint,
            rule: f.rule,
            severity: f.severity,
            title: f.title,
            requests: 0,
            routes: [],
            impactMs: 0,
            seenOnce: false,
            firstEpoch: e.epoch,
            lastEpoch: e.epoch,
            lastSeen: Number.NEGATIVE_INFINITY,
            savedSum: 0,
            savedN: 0,
          };
          by.set(f.fingerprint, g);
        }
        g.requests += f.count;
        if (!g.routes.includes(r.key)) g.routes.push(r.key);
        if (f.maxCount !== undefined) g.maxCount = Math.max(g.maxCount ?? 0, f.maxCount);
        g.savedSum += f.savedMsSum ?? 0;
        g.savedN += f.savedN ?? 0;
        g.severity = worseSev(g.severity, f.severity);
        g.firstEpoch = Math.min(g.firstEpoch, e.epoch);
        g.lastEpoch = Math.max(g.lastEpoch, e.epoch);
        const seen = f.lastSeen ?? e.lastSeen;
        if (seen >= g.lastSeen) {
          g.lastSeen = seen;
          g.title = f.title;
          if (f.fn) g.fn = f.fn;
          if (f.location) g.location = f.location;
          if (f.lastTraceId) g.lastTraceId = f.lastTraceId;
        }
      }
    }
  }
  const out: FindingRollup[] = [];
  for (const { savedSum, savedN, ...g } of by.values()) {
    if (savedN > 0) {
      g.savedMsPerRequest = round(savedSum / savedN);
      g.impactMs = round((savedSum / savedN) * g.requests);
    }
    g.seenOnce = g.requests === 1;
    out.push(g);
  }
  return rankFindings(out);
}

/** Same key as the insights' routeKey and the epoch tracker. */
export function routeKeyOf(t: Pick<TraceRecord, "method" | "route" | "path">): string {
  return `${t.method} ${t.route ?? normalizeUrl(t.path)}`;
}

/** UI's definition of an error request: a 5xx, or an error with no status at all. */
export function isErrorTrace(t: Pick<TraceRecord, "status" | "error">): boolean {
  return t.status !== undefined && t.status > 0 ? t.status >= 500 : !!t.error;
}

export class RouteStatsStore {
  private readonly routes = new Map<string, RouteEntry>();
  private readonly maxRoutes: number;
  private readonly maxEpochs: number;
  private readonly maxFindings: number;
  private readonly maxUrlVariants: number;
  private droppedSpans = 0;
  private newestEpoch = 0;
  since: number;

  constructor(
    opts: StatsOptions = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.maxRoutes = Math.max(1, opts.maxRoutes ?? 500);
    this.maxEpochs = Math.max(1, opts.maxEpochs ?? 5);
    this.maxFindings = Math.max(0, opts.maxFindings ?? 50);
    this.maxUrlVariants = Math.max(0, opts.maxUrlVariants ?? 20);
    this.since = clock();
  }

  /** Feed one finished trace. Never throws. */
  add(t: TraceRecord): void {
    try {
      this.ingest(t);
    } catch {
      /* stats are best effort; never take the response path down */
    }
  }

  private ingest(t: TraceRecord): void {
    const key = routeKeyOf(t);
    const seenAt = t.startedAt + (t.duration ?? 0);
    let r = this.routes.get(key);
    if (r)
      this.routes.delete(key); // re-insert so Map order tracks recency
    else
      r = {
        key,
        method: t.method,
        route: t.route ?? normalizeUrl(t.path),
        kind: t.kind,
        lastSeen: seenAt,
        epochs: new Map(),
        recent: [],
        evicted: 0,
      };
    r.kind = t.kind;
    r.lastSeen = Math.max(r.lastSeen, seenAt);
    this.routes.set(key, r);
    if (this.routes.size > this.maxRoutes) {
      const oldest = this.routes.keys().next().value;
      if (oldest !== undefined) this.routes.delete(oldest);
    }

    const f = t.facts;
    const epoch = f?.epoch ?? 0;
    if (epoch > this.newestEpoch) this.newestEpoch = epoch;
    let e = r.epochs.get(epoch);
    if (!e) {
      e = new EpochAgg(epoch);
      r.epochs.set(epoch, e);
      if (r.epochs.size > 1) {
        // Keep ascending order (an out-of-order epoch is rare but possible with concurrent requests).
        const sorted = [...r.epochs.entries()].sort((a, b) => a[0] - b[0]);
        r.epochs.clear();
        for (const [, v] of sorted.slice(0, -this.maxEpochs)) r.evicted += v.count;
        for (const [k, v] of sorted.slice(-this.maxEpochs)) r.epochs.set(k, v);
        if (!r.epochs.has(epoch)) {
          r.evicted++; // older than every kept epoch
          return;
        }
      }
    }
    e.count++;
    if (isErrorTrace(t)) {
      e.errors++;
      if (t.error) e.errorKinds.thrown++;
      else e.errorKinds.fivexx++;
    } else if (t.error) e.errorKinds.swallowed++;
    const cold = f?.cold ?? false;
    if (cold) e.cold++;
    else if (t.duration !== undefined) {
      e.hist.add(t.duration);
      // Exemplars are examples of the route working: a 500 (or a caught error) that answered in 1ms
      // is not its "fast" run.
      if (!t.error && !isErrorTrace(t)) {
        r.recent.push({ traceId: t.id, ms: t.duration, epoch });
        if (r.recent.length > EXEMPLAR_RING) r.recent.shift();
      }
    }
    let v: VariantAgg | undefined;
    if (t.url) {
      const vk = urlVariantKey(t.url);
      v = e.variants.get(vk);
      if (!v && e.variants.size < this.maxUrlVariants) e.variants.set(vk, (v = new VariantAgg()));
      if (v) {
        v.count++;
        if (!cold && t.duration !== undefined) v.hist.add(t.duration);
      }
    }
    if (f) {
      const ioOf: IoAverages = { db: f.counts.db, fetch: f.counts.fetch, cache: f.counts.cache, fn: f.counts.fn };
      for (const agg of v ? [e, v] : [e]) {
        if (!cold) {
          for (const k of TIME_BUCKETS) agg.timeSum[k] += f.time[k] ?? 0;
          agg.timeN++;
        }
        addIo(agg.io, ioOf);
        agg.ioN++;
      }
      this.droppedSpans += f.droppedSpans;
    }
    // One count per request and fingerprint: a trace can carry a fingerprint twice (request and
    // response payload). Its saving is then the larger of the two.
    const perTrace = new Map<string, { fd: Finding; saved?: number; n?: number }>();
    for (const fd of t.findings ?? []) {
      const cur = perTrace.get(fd.fingerprint);
      if (!cur) perTrace.set(fd.fingerprint, { fd, saved: fd.estSavedMs, n: fd.count });
      else {
        if (fd.estSavedMs !== undefined) cur.saved = Math.max(cur.saved ?? 0, fd.estSavedMs);
        if (fd.count !== undefined) cur.n = Math.max(cur.n ?? 0, fd.count);
        cur.fd = { ...cur.fd, severity: worseSev(cur.fd.severity, fd.severity) };
      }
    }
    for (const [fp, { fd, saved, n }] of perTrace) {
      let c = e.findings.get(fp);
      if (!c) {
        if (e.findings.size >= this.maxFindings) continue;
        c = { fingerprint: fp, rule: fd.rule, severity: fd.severity, title: fd.title, count: 0 };
        e.findings.set(fp, c);
      }
      c.count++;
      c.title = fd.title;
      c.severity = worseSev(c.severity, fd.severity);
      if (fd.fn) c.fn = fd.fn;
      if (fd.location) c.location = fd.location;
      if (n !== undefined) c.maxCount = Math.max(c.maxCount ?? 0, n);
      if (saved !== undefined && Number.isFinite(saved)) {
        c.savedMsSum = round((c.savedMsSum ?? 0) + saved);
        c.savedN = (c.savedN ?? 0) + 1;
      }
      c.lastTraceId = t.id;
      c.lastSeen = seenAt;
    }
    e.firstSeen = Math.min(e.firstSeen, seenAt);
    e.lastSeen = Math.max(e.lastSeen, seenAt);
  }

  /** Late spans reported after `done` (the trace was already counted). */
  noteLateSpan(): void {
    this.droppedSpans++;
  }

  clear(): void {
    this.routes.clear();
    this.droppedSpans = 0;
    this.newestEpoch = 0;
    this.since = this.clock();
  }

  get size(): number {
    return this.routes.size;
  }

  /**
   * `since`: scope to epochs >= since (GET /api/stats?since=<epoch>). Each route keeps only those
   * epochs (merged into `all`), routes without traffic in the scope are left out, totals and findings
   * are re-summed over what is left, and exemplars come from the scope. `delta` stays the route's
   * newest-vs-previous epoch. `scope.partial` = some route dropped epochs the scope reaches back into,
   * so its counts are a lower bound (the same rule as the UI's scopeStatsSince).
   */
  snapshot(opts: { buckets?: boolean; since?: number } = {}): StatsResponse {
    const withBuckets = !!opts.buckets;
    const since = opts.since !== undefined && Number.isFinite(opts.since) ? opts.since : undefined;
    let partial = false;
    const routes: RouteStats[] = [];
    const totals: StatsTotals = {
      requests: 0,
      errors: 0,
      cold: 0,
      routes: this.routes.size,
      droppedSpans: 0,
      errorKinds: { fivexx: 0, thrown: 0, swallowed: 0 },
    };
    for (const r of this.routes.values()) {
      const every = [...r.epochs.values()];
      const kept = since === undefined ? every : every.filter((e) => e.epoch >= since);
      if (since !== undefined && every.length > 0 && r.evicted > 0 && since < every[0]!.epoch) partial = true;
      const newest = kept[kept.length - 1];
      if (!newest) continue;
      const all = new EpochAgg(-1);
      for (const e of kept) all.merge(e, this.maxFindings, this.maxUrlVariants);
      totals.requests += all.count;
      totals.errors += all.errors;
      totals.cold += all.cold;
      addErrorKinds(totals.errorKinds, all.errorKinds);
      const asc = kept.map((e) => e.toJSON(withBuckets));
      const row: RouteStats = {
        key: r.key,
        method: r.method,
        route: r.route,
        kind: r.kind,
        lastSeen: r.lastSeen,
        current: asc[asc.length - 1]!,
        all: all.toJSON(withBuckets),
        epochs: [...asc].reverse(),
      };
      if (r.evicted > 0) row.evicted = r.evicted;
      const delta = epochDelta(row, since === undefined ? asc : every.map((e) => e.toJSON(false)), this.newestEpoch);
      if (delta) row.delta = delta;
      // Exemplars from the kept (and scoped) epochs only, so they agree with the percentiles beside them.
      const ex = pickExemplars(
        r.recent.filter((x) => r.epochs.has(x.epoch) && (since === undefined || x.epoch >= since)),
      );
      if (ex) row.exemplars = ex;
      routes.push(row);
    }
    routes.sort((a, b) => b.lastSeen - a.lastSeen);
    totals.droppedSpans = this.droppedSpans;
    if (since !== undefined) totals.routes = routes.length;
    const findings = rollupFindings(routes.filter((r) => r.kind !== "asset"));
    const out: StatsResponse = { routes, totals, epoch: this.newestEpoch, since: this.since, findings };
    if (since !== undefined) out.scope = { sinceEpoch: since, partial };
    return out;
  }
}
