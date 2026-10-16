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
