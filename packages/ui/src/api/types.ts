// Mirror of @hoplens/core's TraceRecord / Discovery / Meta shapes. Kept inline rather than
// imported so the UI bundle stays self-contained — these are stable wire-format types.

export type HopKind =
  | "request"
  | "proxy"
  | "router"
  | "handler"
  | "render"
  | "function"
  | "fetch"
  | "db"
  | "custom"
  | "response"
  | "compile";

export type TraceKind = "route" | "page" | "rsc" | "action" | "asset" | "other";

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
  /** "call-site": core captured the caller line (r4), so the UI must not re-search the source. */
  via?: "call-site";
}

export interface CapturedError {
  type: string;
  message: string;
  stack: string;
  location?: SourceLocation;
}

export interface BodyCapture {
  contentType?: string;
  size: number;
  json?: unknown;
  text?: string;
  truncated?: boolean;
  binary?: boolean;
}

export interface SpanRecord {
  id: string;
  parentId?: string;
  name: string;
  kind: HopKind;
  type?: string;
  start: number;
  end: number;
  attrs: Record<string, string | number | boolean>;
  location?: SourceLocation;
  args?: unknown;
  result?: unknown;
  error?: CapturedError;
}

export interface LogRecord {
  t: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  location?: SourceLocation;
  spanId?: string;
}

/** Self-time buckets; "fn" is the user's own code (label it "your code"). */
export type TimeBucket = "db" | "cache" | "ext" | "fn" | "framework" | "compile" | "idle";

export interface TraceFacts {
  /** Self-time per bucket (ms); buckets sum to ~duration. */
  time: Record<TimeBucket, number>;
  /** ms from trace start to first response byte, when known. */
  ttfb?: number;
  reqBytes: number;
  resBytes: number;
  counts: { spans: number; db: number; fetch: number; cache: number; fn: number; warn: number; error: number };
  cold: boolean;
  compileMs: number;
  /** Spans that ended after the trace finished: shown in the timeline (attrs["hoplens.late"]), not in facts/findings. */
  droppedSpans: number;
  /** Coarse dev-rebuild epoch counter. */
  epoch: number;
  /** True when the span cap (~2000) stopped facts/analysis early. */
  truncated?: boolean;
}

export type FindingRule =
  | "n-plus-1"
  | "duplicate"
  | "parallelizable"
  | "slow-fn"
  | "fetch-uncached"
  | "cold-compile"
  | "large-payload"
  | "swallowed-error"
  | "logs-on-success";

export type FindingSeverity = "info" | "warn" | "error";

export interface Finding {
  rule: FindingRule;
  severity: FindingSeverity;
  /** One line naming the function/query/host. */
  title: string;
  detail?: string;
  /** Stable across traces (rule + normalized key + route). */
  fingerprint: string;
  spanIds: string[];
  fn?: string;
  location?: SourceLocation;
  count?: number;
  /** Estimated ms saved if fixed; absent when unknown. */
  estSavedMs?: number;
}

export type FindingSummary = Pick<
  Finding,
  "rule" | "severity" | "title" | "fingerprint" | "fn" | "location" | "count" | "estSavedMs"
>;

export interface TraceRecord {
  id: string;
  runId?: string;
  startedAt: number;
  duration?: number;
  done: boolean;
  method: string;
  url: string;
  path: string;
  route?: string;
  routeFile?: string;
  kind: TraceKind;
  status?: number;
  request: { headers: Record<string, string>; body?: BodyCapture };
  response: { headers: Record<string, string>; body?: BodyCapture };
  spans: SpanRecord[];
  logs: LogRecord[];
  error?: CapturedError;
  facts?: TraceFacts;
  findings?: Finding[];
}

export interface TraceSummary {
  id: string;
  runId?: string;
  startedAt: number;
  duration?: number;
  done: boolean;
  method: string;
  path: string;
  url: string;
  route?: string;
  kind: TraceKind;
  status?: number;
  error?: string;
  hops: number;
  facts?: TraceFacts;
  findings?: FindingSummary[];
}

export interface SchemaInfo {
  target: "body" | "query" | "form" | "params";
  name?: string;
  file?: string;
  line?: number;
  shape: unknown;
  example: unknown;
  fields: { path: string; type: string; optional: boolean }[];
}

export interface MethodInfo {
  method: string;
  line: number;
  schemas: SchemaInfo[];
  readsBody: boolean;
}

export interface RouteInfo {
  id: string;
  router: "app" | "pages" | string;
  path: string;
  nextRoute: string;
  file: string;
  params: { name: string; catchAll: boolean; optional: boolean }[];
  methods: MethodInfo[];
}

export interface ProxyInfo {
  file: string;
  line: number;
  matcher: string[];
}

export interface Discovery {
  routes: RouteInfo[];
  proxy?: ProxyInfo;
  appDir?: string;
  typescript: boolean;
  scannedAt: number;
}

export interface Meta {
  app?: string;
  next?: string;
  /** The host framework, as its adapter reported it. */
  framework?: { name: string; version?: string };
  root: string;
  appPort?: number;
  uiPort?: number;
  basePath: string;
  otel: "own" | "attached" | "none";
  configured: boolean;
  autoTrace: boolean | { include?: string[]; exclude?: string[] };
  profiles: Record<string, { description?: string; headers: string[] }>;
}

export interface SourceResponse {
  file: string;
  line: number;
  start: number;
  lines: string[];
}

export interface RunInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  profile?: string;
}

export interface RunResult {
  runId: string;
  traceId?: string;
  status: number;
  error?: string;
  elapsed: number;
}

/* ------------------------------------------------ Phase 2 cross-request endpoints (mirrors core) */

/** One histogram bucket of warm durations (ms). `hi` is null for the open-ended last bucket. */
export interface HistogramBucket {
  lo: number;
  hi: number | null;
  count: number;
}

export interface FindingCount {
  fingerprint: string;
  rule: FindingRule;
  severity: FindingSeverity;
  title: string;
  count: number;
}

/** Aggregates for one route in one dev-rebuild epoch (`epoch = -1` for the merge of kept epochs). */
export interface EpochStats {
  epoch: number;
  count: number;
  /** 5xx, or an error without a status (same definition as stats.isError). */
  errors: number;
  cold: number;
  /** count - cold: the percentile sample size. */
  warm: number;
  p50?: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
  /** Average self time per bucket over warm requests with facts. */
  time?: Record<TimeBucket, number>;
  /** Average calls per request with facts. */
  io?: { db: number; fetch: number; cache: number; fn: number };
  findings: FindingCount[];
  firstSeen: number;
  lastSeen: number;
  /** Only with `?buckets=1`; non-empty buckets only. */
  buckets?: HistogramBucket[];
}

export interface ServerRouteStats {
  /** "GET /api/orders/[id]" */
  key: string;
  method: string;
  /** Route template, else the normalized path. */
  route: string;
  kind: TraceKind;
  lastSeen: number;
  current: EpochStats;
  all: EpochStats;
  /** Kept epochs, newest first. */
  epochs: EpochStats[];
}

export interface StatsTotals {
  requests: number;
  errors: number;
  cold: number;
  routes: number;
  droppedSpans: number;
}

/** GET /api/stats: survives ring-buffer eviction, reset on Clear. */
export interface StatsResponse {
  /** Most recently seen first. */
  routes: ServerRouteStats[];
  totals: StatsTotals;
  epoch: number;
  /** Epoch ms: process start or last clear. */
  since: number;
}

export type QueryKind = "db" | "cache" | "fetch";

export interface QueryStat {
  /** "db:SELECT * FROM t WHERE id = ?" */
  fingerprint: string;
  kind: QueryKind;
  /** Fingerprint without its "db:" / "redis:" / "fetch:" prefix. */
  shape: string;
  system?: string;
  calls: number;
  /** Distinct traces; calls / traces > 1 hints at a loop. */
  traces: number;
  timedCalls: number;
  totalMs: number;
  avgMs?: number;
  p95Ms?: number;
  maxMs?: number;
  /** Span error, or HTTP >= 400 for fetch. */
  errors: number;
  avgRows?: number;
  hits?: number;
  misses?: number;
  /** Top 5. */
  callers: { fn?: string; location?: SourceLocation; calls: number }[];
  /** Top 5, "GET /api/x". */
  routes: { route: string; calls: number }[];
  /** Last 5, newest first, still retained. */
  traceIds: string[];
  lastSeen: number;
}

export interface HostStat {
  /** Lowercased, no credentials; "" = relative URL (the app itself). */
  host: string;
  calls: number;
  p95Ms?: number;
  avgMs?: number;
  maxMs?: number;
  /** 0..100 */
  errorPct: number;
  /** 0..100 of GETs that asked for Next's data cache (request-side intent, not an observed hit). */
  cachedPct: number;
  /** 0..100 of GETs that explicitly opted out (no-store, revalidate 0, ...). */
  uncachedPct: number;
  /** "200": n, ..., "error": failed without a status. */
  statuses: Record<string, number>;
  lastSeen: number;
}

/** GET /api/queries: incremental, survives ring-buffer eviction, reset on Clear. */
export interface QueriesResponse {
  queries: QueryStat[];
  hosts: HostStat[];
  since: number;
}

// WP2 -- cause-first trace: pre-handler wait and per-URL-variant baselines (mirrors core).

export interface TraceFacts {
  /** ms from trace start to the first route-handler span; absent without one (pages, assets). */
  preHandlerMs?: number;
}

/** One URL variant of a route (path + query sorted by key, then value; core `urlVariantKey`). */
export interface UrlVariantStats {
  url: string;
  count: number;
  /** count - cold: the quantile sample. */
  warm: number;
  p50?: number;
  p95?: number;
  /** Average self time per bucket (ms), warm requests of this variant. */
  time?: Record<TimeBucket, number>;
  /** Average I/O counts per request of this variant. */
  io?: { db: number; fetch: number; cache: number; fn: number };
}

export interface EpochStats {
  /** Per URL variant, most requests first; at most 20 per route-epoch. */
  variants?: UrlVariantStats[];
}

// WP8 -- compare: GET /api/compare?a=&b= and /api/compare/baselines?b= (mirrors core compare.ts).

export interface CompareSide {
  id: string;
  method: string;
  url: string;
  path: string;
  route?: string;
  status?: number;
  duration: number;
  startedAt: number;
  done: boolean;
  epoch?: number;
  cold?: boolean;
  ttfb?: number;
  reqBytes?: number;
  resBytes?: number;
  error?: string;
}

export interface BucketDelta {
  bucket: TimeBucket;
  a: number;
  b: number;
  /** b - a, ms. */
  delta: number;
}

export interface CountDelta {
  name: keyof TraceFacts["counts"];
  a: number;
  b: number;
  delta: number;
}

export type CompareRowStatus = "same" | "changed" | "onlyA" | "onlyB";

export interface CompareGroupSide {
  /** Spans folded into this row (x50). */
  count: number;
  /** Union of the members' intervals, ms. */
  wallMs: number;
  /** Sum of the members' durations, ms. */
  totalMs: number;
  /** Member span ids in start order, capped at 100. */
  spanIds: string[];
  start: number;
  location?: SourceLocation;
  errors: number;
}

/** One merged-diff row: every span of one shape under one matched parent path, folded. Depth-first order. */
export interface CompareRow {
  /** `kind|identity|parentPath`, stable across traces of the same route. */
  key: string;
  parentKey?: string;
  depth: number;
  kind: HopKind;
  label: string;
  bucket: TimeBucket;
  a?: CompareGroupSide;
  b?: CompareGroupSide;
  /** b.wallMs - a.wallMs. */
  deltaMs: number;
  /** b.count - a.count. */
  countDelta: number;
  status: CompareRowStatus;
}

/** Span-level match; `key` = row key + `|` + occurrence index. */
export interface CompareSpanPair {
  key: string;
  a?: string;
  b?: string;
  deltaMs?: number;
}

export type JsonType = "null" | "array" | "object" | "string" | "number" | "boolean" | "undefined";

/** JSON-pointer path; array indexes are A's for `remove`, B's otherwise. Redacted values come as "[redacted]". */
export interface JsonDiffOp {
  op: "add" | "remove" | "replace" | "type";
  path: string;
  a?: unknown;
  b?: unknown;
  aType?: JsonType;
  bType?: JsonType;
}

export interface BodyDiff {
  mode: "json" | "text" | "binary" | "mixed" | "none";
  same: boolean;
  ops: JsonDiffOp[];
  /** Over 200 ops: the rest were dropped. */
  truncated: boolean;
  /** A capture was cut short, the diff may miss differences. */
  partial: boolean;
  aSize?: number;
  bSize?: number;
}

export interface HeaderDiffOp {
  op: "add" | "remove" | "replace";
  name: string;
  a?: string;
  b?: string;
}

export interface HeadersDiff {
  same: boolean;
  ops: HeaderDiffOp[];
}

export interface FindingChange {
  fingerprint: string;
  rule: FindingRule;
  title: string;
  a?: number;
  b?: number;
}

export interface FindingsDiff {
  added: FindingSummary[];
  resolved: FindingSummary[];
  changed: FindingChange[];
  kept: number;
}

export interface CompareSummary {
  deltaMs: number;
  deltaPct?: number;
  direction: "slower" | "faster" | "same";
  largestBucket?: BucketDelta;
  /** Row key of the change that drove the largest bucket delta. */
  driverKey?: string;
  /** "B is 55ms slower (+134%): db +52ms, SELECT ... x1 -> x50; new: findMany in a loop (store.ts:88)." */
  sentence: string;
}

/** GET /api/compare?a=<baseline>&b=<subject>. Pins both traces server-side (404 `{missing:["a"|"b"]}`). */
export interface CompareResult {
  a: CompareSide;
  b: CompareSide;
  sameRoute: boolean;
  summary: CompareSummary;
  buckets: BucketDelta[];
  counts: CountDelta[];
  rows: CompareRow[];
  rowsTruncated: boolean;
  pairs: CompareSpanPair[];
  pairsTruncated: boolean;
  spans: { matched: number; onlyA: number; onlyB: number; truncated: boolean };
  findings: FindingsDiff;
  request: { headers: HeadersDiff; body: BodyDiff };
  response: { status: { a?: number; b?: number }; headers: HeadersDiff; body: BodyDiff };
}

export type BaselineKind = "previous-build" | "previous-url" | "route-median";

export interface Baseline {
  kind: BaselineKind;
  id: string;
  duration: number;
  startedAt: number;
  epoch?: number;
  status?: number;
  url: string;
}

/** GET /api/compare/baselines?b=<subject>: default baseline first. DELETE /api/compare/pins/:id releases a pin. */
export interface BaselinesResponse {
  baselines: Baseline[];
}

// WP9a -- epochs, attribution and regressions: GET /api/epochs, GET /api/regressions and the SSE
// stream GET /api/epochs/events (`event: epoch` = EpochView, `event: regression` = RouteRegression).
// Mirrors core epoch.ts, regressions.ts and api/epochs.ts.

/** "restart": the app restarted under a watcher and its source manifest named the changed files (core manifest.ts). */
export type EpochVia = "start" | "src-watch" | "chunk-diff" | "candidates" | "unknown" | "restart";
export type EpochAffectedVia = "imports" | "chunks" | "candidates" | "none";

export interface EpochView {
  /** Epoch number (the `epoch` fact). */
  id: number;
  /** epoch ms the rebuild was noticed. */
  at: number;
  /** Watcher time of the newest build-output write (0 = unknown). */
  rebuiltAt: number;
  /** Project-relative source files changed since the previous epoch (capped at 50). */
  files: string[];
  deleted: string[];
  moreFiles: number;
  via: EpochVia;
  /** Build-output hints ("app/api/feed/route", "src/lib/store.ts") from rebuilt chunk names. */
  candidates: string[];
  /** Route templates the change affects ("/api/orders/[id]"). */
  routes: string[];
  routesVia: EpochAffectedVia;
  /** WP10: set on epochs restored from an earlier dev session (`persist: true`); absent for this one. */
  session?: number;
}

export interface EpochsResponse {
  epoch: number;
  /** Source files are watched, so "src-watch" attribution is possible. */
  sourceWatch: boolean;
  /** Newest first. */
  items: EpochView[];
}

export type RegressionStatus = "regressed" | "improved" | "unchanged" | "insufficient" | "no-traffic";

export interface RegressionSide {
  epoch: number;
  /** Warm requests (the p50 sample). */
  n: number;
  count: number;
  p50?: number;
  p95?: number;
  time?: Record<TimeBucket, number>;
  io?: { db: number; fetch: number; cache: number; fn: number };
}

export interface RegressionBucketDelta {
  bucket: TimeBucket;
  beforeMs: number;
  afterMs: number;
  deltaMs: number;
}

export interface RouteRegression {
  /**
   * UI-derived (state/epochs annotateFixes), never sent by core: this verdict brought the route back
   * after a regression at that epoch (between the baseline and this edit): "fixed the e5 regression".
   */
  fixes?: number;
  /** "GET /api/products" (RouteStats.key). */
  key: string;
  method: string;
  route: string;
  /** Epoch being judged. */
  epoch: number;
  /** Last good epoch it is compared with. */
  baselineEpoch?: number;
  status: RegressionStatus;
  /** min(n) < 8: dim the row, label "low confidence". */
  lowConfidence: boolean;
  before?: RegressionSide;
  after?: RegressionSide;
  deltaMs?: number;
  /** 0.34 = +34%. */
  deltaPct?: number;
  /** Bucket that grew most. */
  grew?: RegressionBucketDelta;
  buckets: RegressionBucketDelta[];
  io?: Record<"db" | "fetch" | "cache" | "fn", { before: number; after: number; delta: number }>;
  findings: { added: FindingCount[]; removed: FindingCount[] };
  /** "variants": compared over the URL variants seen on both sides (traffic-mix safe); "route": whole route. */
  basis: "variants" | "route";
  /** Variants compared when basis = "variants". */
  urls?: string[];
}

export interface RegressionsResponse {
  epoch: number;
  rule: { minPct: number; minMs: number; minN: number; confidentN: number };
  /** Newest epoch first, regressed first within an epoch. Filters: ?epoch=N, ?status=a,b. */
  items: RouteRegression[];
}

// WP6 -- process health: GET /api/health and the SSE `event: health` on /api/events (mirrors core health.ts).

export interface HealthSample {
  /** Epoch ms when the sample closed. */
  t: number;
  /** Event-loop delay over the sample window, in ms. */
  loopP50: number;
  loopP99: number;
  loopMax: number;
  loopMean: number;
  /** Bytes. */
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  /** GC pauses that ended in this window. */
  gcCount: number;
  gcMs: number;
}

export type ProcessErrorKind = "uncaughtException" | "unhandledRejection";

export interface ProcessErrorRecord {
  id: number;
  t: number;
  kind: ProcessErrorKind;
  name: string;
  message: string;
  stack?: string;
}

export interface HealthErrorCounts {
  uncaughtException: number;
  unhandledRejection: number;
}

export interface HealthSnapshot {
  startedAt: number;
  /** Sampler period in ms. */
  sampleMs: number;
  /** False when the monitor is not attached (production, or stopped). */
  active: boolean;
  current: HealthSample | null;
  samples: HealthSample[];
  gc: { count: number; totalMs: number; maxMs: number; byKind: Record<string, number> };
  errors: ProcessErrorRecord[];
  errorCounts: HealthErrorCounts;
  /** Whether unhandled rejections are being recorded (only while the app has its own listener). */
  watchingRejections: boolean;
}

/** SSE `event: health` payload. */
export interface HealthTick {
  current: HealthSample | null;
  errorCounts: HealthErrorCounts;
  /** Errors recorded since the previous tick sent to this client. */
  newErrors: ProcessErrorRecord[];
}

// WP5 -- Overview rollup: impact-ranked findings, errors tally, exemplars, per-epoch delta (mirrors core stats.ts).

/**
 * Failed and quietly failed requests, disjoint: fivexx = answered >= 500 with no exception captured,
 * thrown = failed with an exception captured, swallowed = answered below 500 although an exception
 * was captured. fivexx + thrown = EpochStats.errors.
 */
export interface ErrorKinds {
  fivexx: number;
  thrown: number;
  swallowed: number;
}

export interface FindingCount {
  fn?: string;
  location?: SourceLocation;
  maxCount?: number;
  /** Sum of per-request saving estimates (ms) over `savedN` requests. */
  savedMsSum?: number;
  savedN?: number;
  lastTraceId?: string;
  lastSeen?: number;
}

export interface EpochStats {
  errorKinds?: ErrorKinds;
}

export interface RouteEpochDelta {
  epoch: number;
  baselineEpoch: number;
  /** Regression rule; "insufficient" = warm n < 3 on either side. */
  status: "regressed" | "improved" | "unchanged" | "insufficient" | "no-traffic";
  deltaMs?: number;
  /** 0.34 = +34%. */
  deltaPct?: number;
  nBefore: number;
  nAfter: number;
  lowConfidence: boolean;
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
  n: number;
}

export interface ServerRouteStats {
  /** Newest epoch vs this route's previous one; absent without traffic in the newest epoch. */
  delta?: RouteEpochDelta;
  exemplars?: RouteExemplars;
}

export interface StatsTotals {
  errorKinds?: ErrorKinds;
}

/** One finding across routes and kept epochs (core `rollupFindings`). */
export interface FindingRollup {
  fingerprint: string;
  rule: FindingRule;
  severity: FindingSeverity;
  title: string;
  fn?: string;
  location?: SourceLocation;
  maxCount?: number;
  requests: number;
  routes: string[];
  /** Mean per-request saving (ms). */
  savedMsPerRequest?: number;
  /** savedMsPerRequest x requests: the total. */
  impactMs: number;
  seenOnce: boolean;
  firstEpoch: number;
  lastEpoch: number;
  lastSeen: number;
  lastTraceId?: string;
}

export interface StatsResponse {
  /** Ranked: repeatable before seen-once, then by impact. Absent from older cores. */
  findings?: FindingRollup[];
}

// WP7 -- Replay xN: POST /api/run?repeat=N (mirrors core replay.ts). Interfaces below merge into the
// existing TraceSummary / RunInput declarations.

export interface TraceSummary {
  /** Same id on every run of one Replay xN batch; the log folds them into one row. */
  batchId?: string;
}

export interface RunInput {
  /** 1-50 (more is capped). Also accepted as `?repeat=N`. Absent = single run, RunResult. */
  repeat?: number;
  /** Keep going after a 5xx (default: stop at the first one). */
  keepGoing?: boolean;
}

export interface ReplayWarmStats {
  /** Runs that count: not cold, reached the app, status < 500, trace captured. */
  n: number;
  p50?: number;
  p95?: number;
  min?: number;
  max?: number;
}

export type ReplayExclusion = "cold" | "5xx" | "error" | "no-trace";

export interface ReplayRun {
  runId: string;
  traceId?: string;
  status: number;
  error?: string;
  /** Client-side wall time, ms. */
  elapsed: number;
  /** Server-side trace duration, ms (what the stats use). */
  duration?: number;
  cold: boolean;
  /** Why the run is left out of `warm`; absent = counted. */
  excluded?: ReplayExclusion;
}

export interface ReplayPrevious {
  batchId: string;
  /** epoch ms. */
  at: number;
  warm: ReplayWarmStats;
  coldExcluded: number;
}

/** Response of POST /api/run with `repeat`. 502 when every run failed to reach the app; 400 on bad input. */
export interface ReplayResult {
  batchId: string;
  /** "GET /api/feed" or "GET /api/feed @profile": what "vs last run" compares under. */
  key: string;
  requested: number;
  repeat: number;
  capped: boolean;
  runs: ReplayRun[];
  warm: ReplayWarmStats;
  coldExcluded: number;
  /** 5xx (unless keepGoing), unreachable app, or the 120s total cap. */
  stopped?: "5xx" | "unreachable" | "timeout";
  /** Last batch for the same key (core keeps 100 keys); null on the first. */
  previous: ReplayPrevious | null;
  /** This batch minus previous; p50Pct 0.2 = +20%. Absent when either side has no warm runs. */
  vsPrevious?: { p50Ms: number; p95Ms: number; p50Pct: number };
  /** Last run's trace and status. */
  traceId?: string;
  status: number;
  elapsed: number;
}

// WP8 -- compare pins (UI round): GET /api/compare/pins, POST|DELETE /api/compare/pins/:id (mirrors core api/compare.ts).

/** GET /api/compare/pins: retained traces kept past ring rotation, oldest pin first (core caps at 20). */
export interface PinsResponse {
  /** Every pin (Compare's automatic ones and the user's). */
  pinned: string[];
  /** The user's own pins (`p`); compare never releases these. Absent on an older core. */
  manual?: string[];
}

// WP9c -- module-level chunk diff (core chunkindex.ts): `via: "chunk-diff"` and `routesVia: "chunks"`
// are folded into the WP9a unions EpochVia / EpochAffectedVia above (r3 integration).

// r3 fixes -- core stats.ts keeps a per-route count of requests in epochs it no longer keeps, so a
// "since e<n>" scope that reaches past them can say its numbers are a lower bound.
export interface ServerRouteStats {
  /** Requests counted in epochs this route no longer keeps (`all` leaves them out). Absent when none. */
  evicted?: number;
}

// r4 follow-ups -- GET /api/stats?since=<epoch> (core stats.ts snapshot({since})). A core that knows the
// parameter echoes `scope`; an older one ignores it and answers the unscoped snapshot without it.
export interface StatsResponse {
  /** Present only on a `?since=` request a core understood: epochs >= sinceEpoch are counted. */
  scope?: { sinceEpoch: number; partial: boolean };
}

// Request path (P3 trail UI): POST|GET /api/traces/:id/path, meta.path and the pathTrace stamp
// (mirrors core path/capture.ts, path/truth.ts, path/analyze.ts). Interfaces merge into Meta,
// TraceSummary and TraceRecord above. Truth is decided server-side: the UI only renders it.

export interface PathMeta {
  state: "off" | "on" | "disabled-c8" | "error";
  reason?: string;
}

export interface Meta {
  /** Request path state. Absent on a core that predates it. */
  path?: PathMeta;
}

/** A request-path replay (core TraceRecord.pathTrace). No payload of its own when superseded / failed. */
export interface PathTraceStamp {
  quality: PathQuality;
  replayOf: string;
  supersededBy?: string;
  failed?: string;
}

export interface TraceSummary {
  pathTrace?: PathTraceStamp;
}

export interface TraceRecord {
  pathTrace?: PathTraceStamp;
}

export type PathQuality = "exact" | "partial" | "contaminated";

export type PathWhy =
  | "no-blocks"
  | "contaminated"
  | "join-mismatch"
  | "join-ambiguous"
  | "no-location"
  | "source-unreadable"
  | "too-large"
  | "source-moved"
  | "compiled"
  | "after-throw"
  | "arms-inconsistent"
  | "no-analyzer"
  | "no-function"
  | "no-counter"
  | "suspended";

export type PathTruth = { t: "taken"; n: number } | { t: "not" } | { t: "unknown"; why: PathWhy };

export interface PathArm {
  label: string;
  line?: number;
  count: number | null;
  taken: "taken" | "not-taken" | "unknown";
  why?: PathWhy;
  implied?: boolean;
}

export type PathDecisionKind = "if" | "switch" | "ternary" | "logical" | "try";

export interface PathDecision {
  id: string;
  nodeId: number;
  kind: PathDecisionKind;
  line: number;
  label: string;
  reach: number | null;
  why?: PathWhy;
  arms: PathArm[];
  verdict: "one" | "split-loop" | "split-calls" | "unreached" | "unknown";
  /** Server-made chip text: `then`, `then 1/3 . else 2/3`, `not reached`, `? (after-throw)`. */
  summary: string;
  inLoop: boolean;
}

export interface PathLoop {
  nodeId: number;
  line: number;
  label: string;
  kind: string;
  entries: number | null;
  passes: number | null;
  why?: PathWhy;
}

export interface PathExitVia {
  decision: string;
  label: string;
  arm: string;
  line: number;
}

export interface PathExit {
  nodeId?: number;
  kind: "return" | "throw" | "end" | "exception";
  line: number | null;
  count: number | null;
  why?: PathWhy;
  via?: PathExitVia;
}

export interface PathFnAnalysis {
  status: "ok" | "unknown";
  why?: PathWhy;
  calls: number;
  blended: boolean;
  decisions: PathDecision[];
  loops: PathLoop[];
  exits: PathExit[];
  nodeCount: number;
  truncated?: boolean;
  warnings?: string[];
}

export interface PathFn {
  key: string;
  name: string;
  file: string;
  line: number;
  startLine?: number;
  endLine?: number;
  mapping: "identity" | "none";
  calls: { hops: number; coverage: number | null; checked: boolean };
  truth: PathTruth;
  blocks: boolean;
  truncated?: boolean;
  stale?: boolean;
  analysis?: PathFnAnalysis;
}

export interface PathLane {
  spanId: string;
  kind: "handler" | "function";
  name: string;
  file?: string;
  line?: number;
  fnKey?: string;
  depth: number;
  calls: number;
  truth: PathTruth;
  threw?: boolean;
}

export interface PathPayloadAnalysis {
  text: string;
  exit?: { fnKey: string; nodeId?: number; kind: PathExit["kind"]; line: number | null; via?: PathExitVia };
  ms: number;
  graphsDropped?: boolean;
  error?: string;
}

export interface PathPayload {
  v: number;
  traceId: string;
  replayOf: string;
  quality: PathQuality;
  contamination: string[];
  warnings: string[];
  window: { quietMs: number; settleMs: number; taint: string[]; retries: number };
  lanes: PathLane[];
  functions: Record<string, PathFn>;
  analysis?: PathPayloadAnalysis;
}

export type PathErrorCode =
  | "method"
  | "not-found"
  | "no-path"
  | "superseded"
  | "evicted"
  | "path-off"
  | "busy"
  | "not-quiet"
  | "take-failed"
  | "replay-failed";

/** Every path API error body: `{ code, error, ...details }`. */
export interface PathErrorBody {
  code: PathErrorCode | string;
  error: string;
  /** not-quiet */
  reason?: string;
  inflight?: number;
  requests?: string[];
  /** replay-failed */
  status?: number;
  /** superseded */
  traceId?: string;
  /** evicted */
  replayOf?: string;
  /** path-off */
  state?: PathMeta["state"];
}
