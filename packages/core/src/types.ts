// Trace model — framework-neutral. Field names are part of the SSE/REST contract.

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
  | "response";

export interface SourceLocation {
  /** Project-relative, forward-slash normalized. */
  file: string;
  line: number;
  column?: number;
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
  /** Framework-template path, e.g. `/api/orders/[id]`. */
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
}
