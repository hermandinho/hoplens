import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
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

function decodeBody(
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
      for (const [k, v] of Object.entries(span.attributes))
        if (v !== undefined && !k.startsWith("hoplens.")) attrs[k] = v as any;
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
