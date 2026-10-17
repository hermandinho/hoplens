// Trace model — framework-neutral. Field names are part of the SSE/REST contract.

import type { IncomingMessage, ServerResponse } from "node:http";

export type HopKind =
  | "request"
  | "proxy"
  | "router"
  /** Dev compile / module load (findPageComponents, loadRouteModule, RouteModule.prepare, ...). */
  | "compile"
  | "handler"
  | "render"
  | "function"
  | "fetch"
  | "db"
  | "custom"
  | "response";

export interface SourceLocation {
  /** Project-relative, forward-slash normalized. */
  file: string;
  line: number;
  column?: number;
  /**
   * How the line was found. "call-site": the caller frame captured at runtime (an N+1 through a
   * per-item function points at its loop call), so consumers need not search the source for it.
   */
  via?: "call-site";
}

export interface CapturedError {
  type: string;
  message: string;
  /** Source-mapped, project frames first. */
  stack: string;
  location?: SourceLocation;
}

export interface SpanRecord {
  id: string;
  parentId?: string;
  name: string;
  kind: HopKind;
  /** The framework's own span type, when it provided one (e.g. Next's `next.span_type`). */
  type?: string;
  /** ms since trace start. */
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

export interface BodyCapture {
  contentType?: string;
  size: number;
  json?: unknown;
  text?: string;
  truncated?: boolean;
  binary?: boolean;
}

export type TraceKind = "route" | "page" | "rsc" | "action" | "asset" | "other";

export interface TraceRecord {
  id: string;
  /** Set when the request was fired by the UI's "Run" or "Edit and resend" buttons. */
  runId?: string;
  /** Set on every run of one Replay xN batch (WP7, `x-hoplens-batch`), so the log can fold them. */
  batchId?: string;
  /** epoch ms (fractional). */
  startedAt: number;
  duration?: number;
  done: boolean;
  method: string;
  url: string;
  path: string;
  /** Framework-template route, e.g. `/api/orders/[id]`. */
  route?: string;
  routeFile?: string;
  kind: TraceKind;
  status?: number;
  request: { headers: Record<string, string>; body?: BodyCapture };
  response: { headers: Record<string, string>; body?: BodyCapture };
  spans: SpanRecord[];
  logs: LogRecord[];
  error?: CapturedError;
  /** Computed in finalize() once the trace is done. Absent while in flight or if analysis failed. */
  facts?: TraceFacts;
  findings?: Finding[];
}

/* ---------------------------------------------------------- facts + findings */

/**
 * Where a request's time went. Redis spans stay `kind: "db"` (with `db.system: "redis"`) and are
 * bucketed as "cache" here.
 */
export type TimeBucket = "db" | "cache" | "ext" | "fn" | "framework" | "compile" | "idle";

export interface TraceFacts {
  /**
   * Self-time per bucket (ms), computed by interval union so buckets sum to ~duration. "fn" = user
   * function self time (label it "your code" in UI), "ext" = outgoing fetch/http, "framework" = Next
   * internals, "compile" = dev compile/module load, "idle" = time covered by no child span.
   */
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
  /** Coarse dev-rebuild epoch counter (Phase 1: bumps when the dev build output changes). */
  epoch: number;
  /** True when the span cap (~2000) stopped facts/analysis early. */
  truncated?: boolean;
  /**
   * ms from trace start to the first route-handler span (the dev compile, proxy and routing wait
   * before your code ran). Absent when the trace has no handler span (pages, assets).
   */
  preHandlerMs?: number;
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

export interface Finding {
  rule: FindingRule;
  severity: "info" | "warn" | "error";
  /** One line, names the function/query/host, e.g. "listProducts ran SELECT products x50 (N+1)". */
  title: string;
  detail?: string;
  /** Stable across traces (rule + normalized query/url/fn + route) so the UI can group the same problem across requests. */
  fingerprint: string;
  spanIds: string[];
  fn?: string;
  location?: SourceLocation;
  count?: number;
  /** Estimated ms saved if fixed; omit if unknown. */
  estSavedMs?: number;
}

export type FindingSummary = Pick<
  Finding,
  "rule" | "severity" | "title" | "fingerprint" | "fn" | "location" | "count" | "estSavedMs"
>;

export interface TraceSummary {
  id: string;
  runId?: string;
  batchId?: string;
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

/* ------------------------------------------------------------- discovery */

/** Shape returned by a `DiscoverySource.scan()`. Adapters produce this. */
export interface Discovery {
  routes: RouteInfo[];
  proxy?: ProxyInfo;
  appDir?: string;
  typescript: boolean;
  scannedAt: number;
}

export interface SchemaInfo {
  target: "body" | "query" | "form" | "params";
  name?: string;
  file?: string;
  line?: number;
  shape: unknown; // Shape from @hoplens/schema; kept as unknown here to avoid a core→schema dep
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
  /** Normalised path with `:name` params, e.g. `/api/orders/:id`. */
  path: string;
  /**
   * The framework's route template, e.g. `/api/orders/[id]` on Next or `/api/orders/:id` on Express.
   * Must equal the `TraceRecord.route` the adapter's traces carry: `Runtime.routeInfo()` matches on
   * it to find a trace's route file and handler line. Named for the first adapter; not renamed.
   */
  nextRoute: string;
  /** Project-relative source file. */
  file: string;
  params: { name: string; catchAll: boolean; optional: boolean }[];
  methods: MethodInfo[];
}

export interface ProxyInfo {
  file: string;
  line: number;
  matcher: string[];
}

/** A pluggable route-discovery backend. One per framework adapter. */
export interface DiscoverySource {
  /** Fresh scan. Core calls this throttled; the adapter does not need to cache. */
  scan(): Discovery;
}

/* -------------------------------------------------------------- HTTP tap */

/**
 * Framework-specific hooks around the http.Server.emit tap. Adapters provide this so the
 * runtime knows which URLs to ignore and how to classify an incoming request's shape.
 */
export interface HttpTap {
  /** Internal URL prefixes to skip (framework assets, HMR, favicon, …). */
  internalPrefixes: string[];
  /** Classify the request kind for the trace. Default handles "action", "rsc", "page", "route". */
  classifyRequest?: (headers: Record<string, string | string[] | undefined>, method: string) => TraceKind;
  /**
   * Run every event the request emits ('data', 'end', …) inside the trace's context. Needed when
   * the framework continues the handler from a request event (Express behind body-parser): Node
   * otherwise drops the context after the first body chunk. Default false.
   */
  bindRequestEmitter?: boolean;
  /**
   * The route template and kind of a finished request, for frameworks whose spans carry no
   * `next.route`. Called from finalize() only when no span named a route; `kind` is applied only
   * alongside a route. Must equal the matching `RouteInfo.nextRoute` for the route file to resolve.
   */
  describe?: (req: IncomingMessage, res: ServerResponse) => { route?: string; kind?: TraceKind } | undefined;
  /**
   * The request body the framework already parsed (Express's `req.body`), for traces the Fetch
   * `Request` hooks saw no body on. Redacted and previewed like a captured JSON body.
   */
  requestBody?: (req: IncomingMessage) => { contentType?: string; value: unknown } | undefined;
}
