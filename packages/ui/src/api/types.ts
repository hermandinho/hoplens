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
  | "response";

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
