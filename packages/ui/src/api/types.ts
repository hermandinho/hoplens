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

export type EpochVia = "start" | "src-watch" | "candidates" | "unknown";
export type EpochAffectedVia = "imports" | "candidates" | "none";

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
