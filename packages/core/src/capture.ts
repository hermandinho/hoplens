import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import util from "node:util";
import zlib from "node:zlib";
import { type Span, context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Runtime } from "./runtime";
import { preview, redactHeaders } from "./serialize";
import { callerLocation, mapStack } from "./sourcemap";
import type { BodyCapture, CapturedError, HopKind, SpanRecord, TraceKind, TraceRecord } from "./types";

interface Ctx {
  trace: TraceRecord;
  t0: number; // epoch ms
}

export const als = new AsyncLocalStorage<Ctx>();
const OWN_SERVER = Symbol.for("hoplens.server");
const MAX_BODY = 512 * 1024;
const now = () => performance.timeOrigin + performance.now();
let seq = 0;

/* ------------------------------------------------------------------ requests */

export function isHoplensUrl(url: string): boolean {
  return url === "/__hoplens" || url.startsWith("/__hoplens/") || url.startsWith("/__hoplens?");
}

export function markOwnServer(server: http.Server) {
  (server as any)[OWN_SERVER] = true;
}

function defaultClassify(headers: Record<string, string | string[] | undefined>, method: string): TraceKind {
  if (headers["next-action"]) return "action";
  if (headers.rsc === "1") return "rsc";
  if (String(headers.accept ?? "").includes("text/html") && method === "GET") return "page";
  return "route";
}

export function installHttpHook(rt: Runtime) {
  const internalPrefixes = rt.httpTap?.internalPrefixes ?? [
    "/_next/",
    "/__nextjs",
    "/__webpack",
    "/favicon.ico",
    "/.well-known/",
  ];
  const classify = rt.httpTap?.classifyRequest ?? defaultClassify;
  const isInternal = (url: string) => internalPrefixes.some((p) => url.startsWith(p));

  for (const proto of [http.Server.prototype, https.Server.prototype] as any[]) {
    if (proto.__hoplensPatched) continue;
    const orig = proto.emit;
    proto.__hoplensPatched = true;
    proto.emit = function (this: http.Server, event: string, ...args: any[]) {
      if (event !== "request") return orig.call(this, event, ...args);
      const [req, res] = args as [http.IncomingMessage, http.ServerResponse];
      const url = req.url ?? "/";
      const own = (this as any)[OWN_SERVER];
      if (!own && !rt.appPort) {
        const addr = this.address();
        if (addr && typeof addr === "object") rt.appPort = addr.port;
      }
      if (own || isHoplensUrl(url)) {
        rt.handleUi(req, res);
        return true;
      }
      if (isInternal(url)) return orig.call(this, event, ...args);
      const ctx = startTrace(rt, req, res, classify);
      return als.run(ctx, () => orig.call(this, event, ...args));
    };
  }
}

type Classifier = (headers: Record<string, string | string[] | undefined>, method: string) => TraceKind;

function startTrace(rt: Runtime, req: http.IncomingMessage, res: http.ServerResponse, classify: Classifier): Ctx {
  const url = req.url ?? "/";
  const t0 = now();
  const runId = typeof req.headers["x-hoplens-run"] === "string" ? req.headers["x-hoplens-run"] : undefined;
  const headers = { ...req.headers } as Record<string, any>;
  headers["x-hoplens-run"] = undefined;
  const traceRec: TraceRecord = {
    id: `tr_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    runId,
    startedAt: t0,
    done: false,
    method: req.method ?? "GET",
    url,
    path: url.split("?")[0] ?? url,
    kind: classify(headers, req.method ?? "GET"),
    request: { headers: redactHeaders(headers, rt.redactor) },
    response: { headers: {} },
    spans: [],
    logs: [],
  };
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers))
    if (v !== undefined) raw[k] = Array.isArray(v) ? v.join(", ") : String(v);
  rt.store.add(traceRec, { rawHeaders: raw });
  captureResponse(rt, traceRec, res, t0);
  return { trace: traceRec, t0 };
}

function captureResponse(rt: Runtime, t: TraceRecord, res: http.ServerResponse, t0: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const keep = (chunk: any, encoding?: any) => {
    if (chunk == null || typeof chunk === "function") return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8")
        : Buffer.from(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength ?? undefined);
    size += buf.length;
    if (size <= MAX_BODY) chunks.push(buf);
    else truncated = true;
  };
  const write = res.write;
  const end = res.end;
  res.write = function (this: any, chunk: any, ...rest: any[]) {
    try {
      keep(chunk, rest[0]);
    } catch {
      /* never break the response */
    }
    return (write as any).call(this, chunk, ...rest);
  } as any;
  res.end = function (this: any, chunk?: any, ...rest: any[]) {
    try {
      keep(chunk, rest[0]);
    } catch {
      /* never break the response */
    }
    return (end as any).call(this, chunk, ...rest);
  } as any;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const endAt = now();
    // Spans end a tick after the socket write; give them a moment to land.
    // Spans end a tick after the socket write; give them a moment to land.
    setTimeout(() => {
      t.duration = endAt - t0;
      t.status = res.statusCode;
      t.response.headers = redactHeaders(res.getHeaders() as Record<string, unknown>, rt.redactor);
      t.response.body = decodeBody(
        Buffer.concat(chunks),
        size,
        truncated,
        String(res.getHeader("content-type") ?? ""),
        String(res.getHeader("content-encoding") ?? ""),
        rt,
      );
      finalize(rt, t);
      rt.store.finish(t);
    }, 40);
  };
  res.once("finish", finish);
  res.once("close", finish);
}

export function decodeBody(
  buf: Buffer,
  size: number,
  truncated: boolean,
  contentType: string,
  encoding: string,
  rt: Runtime,
): BodyCapture | undefined {
  if (!size) return undefined;
  let data = buf;
  if (!truncated) {
    try {
      if (encoding.includes("gzip")) data = zlib.gunzipSync(buf);
      else if (encoding.includes("br")) data = zlib.brotliDecompressSync(buf);
      else if (encoding.includes("deflate")) data = zlib.inflateSync(buf);
    } catch {
      /* keep raw */
    }
  }
  return toCapture(data, size, truncated, contentType, rt);
}

export function toCapture(
  data: Buffer,
  size: number,
  truncated: boolean,
  contentType: string,
  rt: Runtime,
): BodyCapture {
  const out: BodyCapture = { contentType: contentType || undefined, size, truncated: truncated || undefined };
  const textual = /json|text|xml|javascript|x-www-form-urlencoded|event-stream/.test(contentType) || !contentType;
  if (!textual) {
    out.binary = true;
    return out;
  }
  const text = data.toString("utf8");
  if (/json/.test(contentType) || (!contentType && /^\s*[[{]/.test(text))) {
    try {
      out.json = preview(JSON.parse(text), rt.redactor);
      return out;
    } catch {
      /* fall through to text */
    }
  }
  out.text = text.length > 20000 ? `${text.slice(0, 20000)}…` : text;
  return out;
}

/* ------------------------------------------------------------- request body */

export function installBodyHooks(rt: Runtime) {
  const proto = (globalThis as any).Request?.prototype;
  if (!proto || proto.__hoplensPatched) return;
  proto.__hoplensPatched = true;
  for (const method of ["json", "text", "formData", "arrayBuffer", "blob"] as const) {
    const orig = proto[method];
    if (typeof orig !== "function") continue;
    proto[method] = async function (this: Request, ...args: any[]) {
      const value = await orig.apply(this, args);
      try {
        const ctx = als.getStore();
        if (ctx && !ctx.trace.request.body && sameRequest(ctx.trace, this)) {
          const ct = this.headers.get("content-type") ?? "";
          if (method === "json")
            ctx.trace.request.body = { contentType: ct, size: 0, json: preview(value, rt.redactor) };
          else if (method === "text") {
            ctx.trace.request.body = toCapture(Buffer.from(value), value.length, false, ct || "text/plain", rt);
          } else if (method === "formData") {
            ctx.trace.request.body = { contentType: ct, size: 0, json: preview(formToObject(value), rt.redactor) };
          } else {
            ctx.trace.request.body = {
              contentType: ct,
              size: (value as any).byteLength ?? (value as any).size ?? 0,
              binary: true,
            };
          }
          if (ctx.trace.request.body.size === 0 && ctx.trace.request.body.json !== undefined) {
            ctx.trace.request.body.size = Buffer.byteLength(JSON.stringify(value) ?? "");
          }
        }
      } catch {
        /* capture is best effort */
      }
      return value;
    };
  }
}

function sameRequest(t: TraceRecord, req: Request): boolean {
  try {
    return new URL(req.url).pathname === t.path || req.method === t.method;
  } catch {
    return true;
  }
}

function formToObject(fd: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    const val = typeof v === "string" ? v : `[File ${v.name} ${v.size} bytes]`;
    out[k] = k in out ? ([] as unknown[]).concat(out[k], val) : val;
  }
  return out;
}

/* ------------------------------------------------------------------ console */

export function installConsoleHook(rt: Runtime) {
  const c = console as any;
  if (c.__hoplensPatched) return;
  c.__hoplensPatched = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = c[level];
    c[level] = function (...args: any[]) {
      const ctx = als.getStore();
      if (ctx && ctx.trace.logs.length < 500) {
        try {
          const text = util.format(...args).replace(/\x1b\[[0-9;]*m/g, "");
          const span = trace.getActiveSpan();
          ctx.trace.logs.push({
            t: now() - ctx.t0,
            level,
            text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
            location: callerLocation(rt.root, 2),
            spanId: span?.spanContext().spanId,
          });
        } catch {
          /* ignore */
        }
      }
      return orig.apply(this, args);
    };
  }
}

/* ------------------------------------------------------------ OpenTelemetry */

const spanCtx = new WeakMap<object, Ctx>();

// Maps Next's `next.span_type` into our HopKind. Changing these reshapes the UI's journey.
function classify(name: string, type: string | undefined, attrs: Record<string, any>): HopKind | null {
  if (attrs["hoplens.kind"]) return attrs["hoplens.kind"];
  switch (type) {
    case "Middleware.execute":
      return "proxy";
    case "BaseServer.handleRequest":
      // Next's outer root carries `next.bubble`; the inner one is the real request.
      return attrs["next.bubble"] ? null : "request";
    case "AppRouteRouteHandlers.runHandler":
      return "handler";
    case "AppRender.fetch":
      return "fetch";
    case "NextNodeServer.startResponse":
      return "response";
    case "NextNodeServer.findPageComponents":
    case "LoadComponents.loadRouteModule":
    case "RouteModule.prepare":
    case "AppRouteRouteModule.loadUserland":
    case "NextNodeServer.getRequestHandler":
      return "router";
    case "Instrumentation.loadModule":
    case "Instrumentation.register":
      return null;
  }
  if (/^executing api route/.test(name)) return "handler";
  if (type && /Render|ResolveMetadata|generateMetadata|AppRender/.test(type)) return "render";
  if (attrs["db.system"] || attrs["db.statement"] || attrs["db.query.text"] || name.startsWith("prisma:")) return "db";
  if (attrs["http.url"] || attrs["url.full"]) return "fetch";
  return "custom";
}

function hrToMs(hr: [number, number]): number {
  return hr[0] * 1000 + hr[1] / 1e6;
}

const DB_PARAM_KEYS = /^(db\.(params|values|bind|statement\.params)|hoplens\.db\.params)$/i;

class HoplensProcessor implements SpanProcessor {
  constructor(private rt: Runtime) {}
  onStart(span: Span & ReadableSpan): void {
    const ctx = als.getStore();
    if (ctx) spanCtx.set(span, ctx);
  }
  onEnd(span: ReadableSpan): void {
    const ctx = spanCtx.get(span);
    if (!ctx) return;
    try {
      const attrs: Record<string, any> = {};
      for (const [k, v] of Object.entries(span.attributes)) {
        if (v === undefined || k.startsWith("hoplens.")) continue;
        // Drivers often attach bound params as raw strings; redact them so a
        // password or token in a WHERE clause doesn't leak into the UI.
        attrs[k] = DB_PARAM_KEYS.test(k) ? redactParams(v, this.rt.redactor) : (v as any);
      }
      const type = attrs["next.span_type"];
      const kind = classify(span.name, type, span.attributes as any);
      if (!kind) return;
      const parent = (span as any).parentSpanContext?.spanId ?? (span as any).parentSpanId;
      const rec: SpanRecord = {
        id: span.spanContext().spanId,
        parentId: parent,
        name: span.name,
        kind,
        type,
        start: hrToMs(span.startTime as any) - ctx.t0,
        end: hrToMs(span.endTime as any) - ctx.t0,
        attrs,
      };
      const a = span.attributes as any;
      if (a["hoplens.file"]) rec.location = { file: a["hoplens.file"], line: Number(a["hoplens.line"]) || 1 };
      if (a["hoplens.args"]) rec.args = safeJson(a["hoplens.args"]);
      if (a["hoplens.result"]) rec.result = safeJson(a["hoplens.result"]);
      const ex = span.events.find((e) => e.name === "exception");
      if (ex || span.status.code === 2) rec.error = toError(ex?.attributes ?? {}, span.status.message, this.rt.root);
      ctx.trace.spans.push(rec);
    } catch {
      /* never throw from a processor */
    }
  }
  forceFlush() {
    return Promise.resolve();
  }
  shutdown() {
    return Promise.resolve();
  }
}

function safeJson(s: unknown) {
  try {
    return JSON.parse(String(s));
  } catch {
    return s;
  }
}

function redactParams(v: unknown, r: ReturnType<typeof import("./serialize").makeRedactor>): string | number | boolean {
  // Keep OTel attribute types; stringify complex values so the processor
  // doesn't drop them (OTel attrs can only be scalars/arrays of scalars).
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return JSON.stringify(preview(parsed, r));
    } catch {
      return v.length > 400 ? `${v.slice(0, 400)}… (redacted-length ${v.length})` : v;
    }
  }
  if (typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(preview(v, r));
}

function toError(a: Record<string, any>, statusMessage: string | undefined, root: string): CapturedError {
  const stack = String(a["exception.stacktrace"] ?? "");
  const mapped = stack ? mapStack(stack, root) : { stack: "", location: undefined };
  return {
    type: String(a["exception.type"] ?? "Error"),
    message: String(a["exception.message"] ?? statusMessage ?? "Error"),
    stack: mapped.stack,
    location: mapped.location,
  };
}

export function installOtel(rt: Runtime): "own" | "attached" | "none" {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const processor = new HoplensProcessor(rt);
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  if (trace.setGlobalTracerProvider(provider)) return "own";
  // Someone (e.g. @vercel/otel, Sentry) registered first: ride along on their provider.
  const existing: any = (trace.getTracerProvider() as any).getDelegate?.() ?? trace.getTracerProvider();
  const multi = existing?._activeSpanProcessor ?? existing?.activeSpanProcessor;
  if (multi && Array.isArray(multi._spanProcessors)) {
    multi._spanProcessors.push(processor);
    return "attached";
  }
  if (typeof existing?.addSpanProcessor === "function") {
    existing.addSpanProcessor(processor);
    return "attached";
  }
  return "none";
}

/* ------------------------------------------------------------- fetch hook */

/**
 * Wraps `globalThis.fetch` so every outbound call shows up as a dedicated
 * span with cache attribution (`cache` option, Next's `revalidate`/`tags`,
 * and the response-side signals edge CDNs set — `x-vercel-cache`,
 * `cf-cache-status`, `age`). We only emit a span when a trace is active in
 * the ALS, so the UI's own `/api/run` loop-back and Node internals stay
 * silent. Idempotent via Symbol.
 */
const FETCH_PATCHED = Symbol.for("hoplens.fetchPatched");

export function installFetchHook(rt: Runtime) {
  const g = globalThis as any;
  const orig: typeof fetch | undefined = g.fetch;
  if (!orig || g[FETCH_PATCHED]) return;
  g[FETCH_PATCHED] = true;
  const tracer = trace.getTracer("hoplens");

  g.fetch = function hoplensFetch(input: any, init?: any) {
    const ctx = als.getStore();
    if (!ctx) return orig(input, init);

    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    // Skip Hoplens's own loop-back probe so we don't trace ourselves.
    try {
      const u = new URL(url, "http://local");
      if (isHoplensUrl(u.pathname)) return orig(input, init);
    } catch {
      /* ignore */
    }

    const method = String(init?.method ?? (input as any)?.method ?? "GET").toUpperCase();
    const requestCache: string | undefined = init?.cache ?? (input as any)?.cache;
    const nextOpts = init?.next ?? (input as any)?.next;
    const location = callerLocation(rt.root, 2);

    const attrs: Record<string, any> = {
      "hoplens.kind": "fetch",
      "http.method": method,
      "url.full": url,
    };
    if (requestCache) attrs["hoplens.fetch.cache"] = requestCache;
    if (nextOpts?.revalidate !== undefined) attrs["hoplens.fetch.revalidate"] = String(nextOpts.revalidate);
    if (Array.isArray(nextOpts?.tags)) attrs["hoplens.fetch.tags"] = nextOpts.tags.join(", ");
    if (location) {
      attrs["hoplens.file"] = location.file;
      attrs["hoplens.line"] = location.line;
    }

    return tracer.startActiveSpan(`fetch ${method} ${shortenUrl(url)}`, { attributes: attrs }, (span) => {
      const started = now();
      return (orig as any)(input, init).then(
        (res: Response) => {
          try {
            span.setAttribute("http.response.status_code", res.status);
            const vercel = res.headers.get("x-vercel-cache");
            const cf = res.headers.get("cf-cache-status");
            const age = res.headers.get("age");
            const cc = res.headers.get("cache-control");
            if (vercel) span.setAttribute("hoplens.fetch.cacheHit", vercel);
            else if (cf) span.setAttribute("hoplens.fetch.cacheHit", cf);
            else if (age && Number(age) > 0) span.setAttribute("hoplens.fetch.cacheHit", `age=${age}`);
            else if (requestCache === "force-cache") span.setAttribute("hoplens.fetch.cacheHit", "force-cache");
            else if (requestCache === "no-store") span.setAttribute("hoplens.fetch.cacheHit", "no-store");
            if (cc) span.setAttribute("hoplens.fetch.cacheControl", cc);
            if (res.status >= 400) span.setStatus({ code: 2, message: `HTTP ${res.status}` });
          } catch {
            /* best effort */
          }
          span.setAttribute("hoplens.duration", Math.round(now() - started));
          span.end();
          return res;
        },
        (err: any) => {
          if (err instanceof Error) span.recordException(err);
          span.setStatus({ code: 2, message: err?.message ?? String(err) });
          span.end();
          throw err;
        },
      );
    });
  };
}

function shortenUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return u.length > 80 ? `${u.slice(0, 80)}…` : u;
  }
}

/* -------------------------------------------------------------- pg driver */

/**
 * `pg` (node-postgres) doesn't ship OTel out of the box. We lazy-resolve it
 * from the host app's `node_modules` and patch `Client.prototype.query` to
 * open a hoplens span with the SQL, redacted bound params, and row count.
 *
 * Patched once per process; safe when pg isn't installed (silent no-op).
 */
const PG_PATCHED = Symbol.for("hoplens.pgPatched");

export function installPgHook(rt: Runtime) {
  const g = globalThis as any;
  if (g[PG_PATCHED]) return;
  // Resolve pg from the app's dependency tree, not Hoplens's own.
  let pg: any;
  try {
    const req = createRequire(path.join(rt.root, "package.json"));
    pg = req("pg");
  } catch {
    return;
  }
  const Client = pg?.Client;
  if (!Client?.prototype?.query || Client.prototype.__hoplensPatched) return;
  Client.prototype.__hoplensPatched = true;
  g[PG_PATCHED] = true;
  const tracer = trace.getTracer("hoplens");
  const origQuery = Client.prototype.query;

  Client.prototype.query = function patchedQuery(this: any, ...args: any[]) {
    const ctx = als.getStore();
    if (!ctx) return origQuery.apply(this, args);

    let text: string | undefined;
    let values: unknown;
    if (typeof args[0] === "string") {
      text = args[0];
      values = args[1];
    } else if (args[0] && typeof args[0].text === "string") {
      text = args[0].text;
      values = args[0].values;
    }
    if (!text) return origQuery.apply(this, args);

    const location = callerLocation(rt.root, 2);
    const attrs: Record<string, any> = {
      "hoplens.kind": "db",
      "db.system": "postgresql",
      "db.statement": text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
    };
    if (values !== undefined) {
      try {
        attrs["hoplens.db.params"] = JSON.stringify(preview(values, rt.redactor));
      } catch {
        /* ignore */
      }
    }
    if (location) {
      attrs["hoplens.file"] = location.file;
      attrs["hoplens.line"] = location.line;
    }

    return tracer.startActiveSpan("pg.query", { attributes: attrs }, (span) => {
      const started = now();
      try {
        const out = origQuery.apply(this, args);
        if (out && typeof out.then === "function") {
          return out.then(
            (r: any) => {
              if (r && typeof r.rowCount === "number") span.setAttribute("db.rows", r.rowCount);
              span.setAttribute("hoplens.duration", Math.round(now() - started));
              span.end();
              return r;
            },
            (err: any) => {
              if (err instanceof Error) span.recordException(err);
              span.setStatus({ code: 2, message: err?.message ?? String(err) });
              span.end();
              throw err;
            },
          );
        }
        span.end();
        return out;
      } catch (err: any) {
        if (err instanceof Error) span.recordException(err);
        span.setStatus({ code: 2, message: err?.message ?? String(err) });
        span.end();
        throw err;
      }
    });
  };
}

/* ---------------------------------------------------------------- redis */

/**
 * Instruments the two popular Redis clients. Both are lazy-required from the
 * host app's `node_modules` so Hoplens has no runtime dep on either.
 *
 *  - `ioredis`: patches `Redis.prototype.sendCommand` which every method
 *    (get/set/hset/hgetall/pipeline/…) funnels through.
 *  - `redis` (node-redis v4+): patches the internal command sender. v4 moved
 *    things around; we hook `createClient` and intercept `.sendCommand` on
 *    the returned client, falling back to patching the module-level
 *    `commandOptions` surface for older versions.
 *
 * Spans land as `kind: "db"` with `db.system: "redis"` so the existing
 * UI treats them like any DB hop; the Flow view's classifier bucket them
 * into the Cache lane via `db.system`.
 */
const REDIS_PATCHED = Symbol.for("hoplens.redisPatched");

export function installRedisHook(rt: Runtime) {
  const g = globalThis as any;
  if (g[REDIS_PATCHED]) return;
  g[REDIS_PATCHED] = true;
  const req = createRequire(path.join(rt.root, "package.json"));
  const tracer = trace.getTracer("hoplens");

  // ioredis — most common in Node backends. Default export is the class.
  try {
    const mod = req("ioredis");
    const Redis = mod.default ?? mod.Redis ?? mod;
    const proto = Redis?.prototype;
    if (proto?.sendCommand && !proto.__hoplensPatched) {
      proto.__hoplensPatched = true;
      const orig = proto.sendCommand;
      proto.sendCommand = function patchedSend(this: any, command: any, ...rest: any[]) {
        const ctx = als.getStore();
        if (!ctx || !command) return orig.call(this, command, ...rest);
        const name = String(command.name ?? "command").toUpperCase();
        return instrumentRedis(tracer, rt, name, command.args, () => orig.call(this, command, ...rest));
      };
    }
  } catch {
    /* no ioredis installed */
  }

  // node-redis v4+ returns a client from createClient(); patch its sendCommand.
  try {
    const mod = req("redis");
    const createClient = mod.createClient;
    if (typeof createClient === "function" && !mod.__hoplensPatched) {
      mod.__hoplensPatched = true;
      mod.createClient = function patchedCreateClient(...args: any[]) {
        const client = createClient.apply(this, args);
        if (client && typeof client.sendCommand === "function" && !client.__hoplensPatched) {
          client.__hoplensPatched = true;
          const orig = client.sendCommand.bind(client);
          client.sendCommand = (cmd: any[], options?: any) => {
            const ctx = als.getStore();
            if (!ctx || !Array.isArray(cmd) || cmd.length === 0) return orig(cmd, options);
            const name = String(cmd[0]).toUpperCase();
            return instrumentRedis(tracer, rt, name, cmd.slice(1), () => orig(cmd, options));
          };
        }
        return client;
      };
    }
  } catch {
    /* no redis installed */
  }
}

function instrumentRedis(
  tracer: ReturnType<typeof trace.getTracer>,
  rt: Runtime,
  command: string,
  args: unknown[],
  invoke: () => any,
) {
  const location = callerLocation(rt.root, 4);
  const key = Array.isArray(args) && args.length > 0 && typeof args[0] === "string" ? (args[0] as string) : undefined;
  const attrs: Record<string, any> = {
    "hoplens.kind": "db",
    "db.system": "redis",
    "db.operation": command,
    "db.statement": key ? `${command} ${key}` : command,
  };
  if (key) attrs["hoplens.redis.key"] = key;
  if (args.length > 1) {
    try {
      attrs["hoplens.db.params"] = JSON.stringify(preview(args.slice(1), rt.redactor));
    } catch {
      /* best effort */
    }
  }
  if (location) {
    attrs["hoplens.file"] = location.file;
    attrs["hoplens.line"] = location.line;
  }

  return tracer.startActiveSpan(`redis ${command}`, { attributes: attrs }, (span) => {
    try {
      const out = invoke();
      if (out && typeof out.then === "function") {
        return out.then(
          (v: any) => {
            span.end();
            return v;
          },
          (err: any) => {
            if (err instanceof Error) span.recordException(err);
            span.setStatus({ code: 2, message: err?.message ?? String(err) });
            span.end();
            throw err;
          },
        );
      }
      span.end();
      return out;
    } catch (err: any) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: 2, message: err?.message ?? String(err) });
      span.end();
      throw err;
    }
  });
}

/* -------------------------------------------------------- external db emit */

/**
 * Programmatic entrypoint for adapters that know a query ran but don't own
 * the driver (e.g. Drizzle's `logger` hook). Emits a zero-duration `db` hop
 * carrying the SQL + redacted params.
 */
export function makeEmitDb(rt: Runtime) {
  const tracer = trace.getTracer("hoplens");
  return function emitDb(info: { system?: string; query: string; params?: unknown; name?: string }) {
    const ctx = als.getStore();
    if (!ctx) return;
    const attrs: Record<string, any> = {
      "hoplens.kind": "db",
      "db.system": info.system ?? "sql",
      "db.statement": info.query.length > 4000 ? `${info.query.slice(0, 4000)}…` : info.query,
    };
    if (info.params !== undefined) {
      try {
        attrs["hoplens.db.params"] = JSON.stringify(preview(info.params, rt.redactor));
      } catch {
        /* ignore */
      }
    }
    tracer.startActiveSpan(info.name ?? "db.query", { attributes: attrs }, (span) => span.end());
  };
}

/* ------------------------------------------------------------ function wrap */

interface WrapMeta {
  name: string;
  file: string;
  line: number;
}

export function makeWrap(rt: Runtime) {
  const tracer = trace.getTracer("hoplens");
  return function wrap<F extends (...args: any[]) => any>(fn: F, meta: WrapMeta): F {
    if (typeof fn !== "function" || (fn as any).__hoplens) return fn;
    const location = resolveMeta(meta, rt);
    const wrapped = function (this: any, ...args: any[]) {
      const ctx = als.getStore();
      if (!ctx) return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
      return tracer.startActiveSpan(
        meta.name,
        {
          attributes: {
            "hoplens.kind": "function",
            "hoplens.file": location.file,
            "hoplens.line": location.line,
            "hoplens.args": JSON.stringify(preview(args, rt.redactor)),
          },
        },
        (span) => {
          const fail = (err: unknown) => {
            if (err instanceof Error) span.recordException(err);
            else span.recordException({ name: "Thrown", message: String(err) });
            span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
            span.end();
          };
          let out: any;
          try {
            out = new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
          } catch (err) {
            fail(err);
            throw err;
          }
          if (out instanceof Promise) {
            return out.then(
              (v) => {
                setResult(span, v, rt);
                span.end();
                return v;
              },
              (err) => {
                fail(err);
                throw err;
              },
            );
          }
          setResult(span, out, rt);
          span.end();
          return out;
        },
      );
    } as unknown as F;
    try {
      Object.defineProperty(wrapped, "name", { value: fn.name });
      Object.defineProperty(wrapped, "length", { value: fn.length });
      Object.assign(wrapped, fn);
      (wrapped as any).prototype = fn.prototype;
      (wrapped as any).__hoplens = true;
    } catch {
      /* cosmetic */
    }
    return wrapped;
  };
}

function setResult(span: Span, v: unknown, rt: Runtime) {
  try {
    if (v !== undefined) span.setAttribute("hoplens.result", JSON.stringify(preview(v, rt.redactor)));
  } catch {
    /* ignore */
  }
}

function resolveMeta(meta: WrapMeta, rt: Runtime): { file: string; line: number } {
  if (meta.line > 0) return { file: meta.file, line: meta.line };
  const m = meta.file.match(/^(.*):(\d+)$/);
  if (!m) return { file: meta.file, line: 0 };
  const mapped = mapStack(`Error\n    at x (${m[1]}:${m[2]}:1)`, rt.root);
  return mapped.location ? { file: mapped.location.file, line: mapped.location.line } : { file: meta.file, line: 0 };
}

/* --------------------------------------------------------------- finalize */

function finalize(rt: Runtime, t: TraceRecord) {
  t.spans.sort((a, b) => a.start - b.start);
  const root = t.spans.find((s) => s.kind === "request");
  const route = root?.attrs["next.route"] ?? t.spans.find((s) => s.attrs["next.route"])?.attrs["next.route"];
  // Next 15 reports app routes as "/api/x/route" — the user-facing path has no `/route`.
  if (route) t.route = String(route).replace(/\/route$/, "") || "/";
  if (t.spans.some((s) => s.kind === "handler")) t.kind = "route";
  else if (t.kind === "route" && t.spans.some((s) => s.kind === "render")) t.kind = "page";

  const info = t.route ? rt.routeInfo(t.route, t.method) : undefined;
  if (info) t.routeFile = info.file;
  for (const s of t.spans) {
    if (s.kind === "handler" && info && !s.location) s.location = { file: info.file, line: info.line };
    if (s.kind === "proxy" && !s.location) {
      const p = rt.proxyFile();
      if (p) s.location = p;
    }
  }
  const errored = t.spans.filter((s) => s.error);
  if (errored.length) {
    // Deepest failing span is where the error originated.
    const deepest = errored.reduce((a, b) => (b.start >= a.start ? b : a));
    t.error = deepest.error;
  }
}
