import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { Runtime } from "./runtime";
import { preview } from "./serialize";
import { summarize } from "./store";
import type { TraceRecord } from "./types";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const UI_SEARCH_ROOTS = [
  path.join(__dirname, "..", "ui"),
  path.join(__dirname, "..", "..", "ui"),
  path.join(__dirname, "..", "..", "@hoplens", "ui"),
];

let uiCache: { mtimeMs: number; html: string } | null = null;
function uiHtml(): string {
  const file = UI_SEARCH_ROOTS.map((d) => path.join(d, "index.html")).find((f) => fs.existsSync(f));
  if (!file) return "<!doctype html><title>Hoplens</title><p>UI bundle missing. Reinstall @hoplens/core.</p>";
  const stat = fs.statSync(file);
  if (!uiCache || uiCache.mtimeMs !== stat.mtimeMs)
    uiCache = { mtimeMs: stat.mtimeMs, html: fs.readFileSync(file, "utf8") };
  return uiCache.html;
}

/* ------------------------------------------------------------------ routing */

type Handler = (ctx: HandlerCtx) => Promise<void> | void;
interface HandlerCtx {
  rt: Runtime;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  params: Record<string, string>;
}

interface Route {
  method: "GET" | "POST" | "DELETE";
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const routes: Route[] = [];
function addRoute(method: Route["method"], pattern: string, handler: Handler) {
  const paramNames: string[] = [];
  const re = new RegExp(
    `^${pattern.replace(/:([a-zA-Z_][\w]*)/g, (_m, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    })}$`,
  );
  routes.push({ method, pattern: re, paramNames, handler });
}

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.paramNames.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
    return { route: r, params };
  }
  return null;
}

/* -------------------------------------------------------------- primitives */

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 5 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* ------------------------------------------------------------------ routes */

addRoute("GET", "/", ({ rt, res }) => {
  // `rt` present so a future auth guard can see the Runtime.
  void rt;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(uiHtml());
});

addRoute("GET", "/index.html", ({ res }) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(uiHtml());
});

addRoute("GET", "/api/meta", ({ rt, res }) => {
  let nextVersion: string | undefined;
  let appName: string | undefined;
  try {
    appName = JSON.parse(fs.readFileSync(path.join(rt.root, "package.json"), "utf8")).name;
    nextVersion = JSON.parse(
      fs.readFileSync(require.resolve("next/package.json", { paths: [rt.root] }), "utf8"),
    ).version;
  } catch {
    /* optional */
  }
  json(res, 200, {
    app: appName,
    next: nextVersion,
    root: rt.root,
    appPort: rt.appPort ?? (Number(process.env.PORT) || undefined),
    uiPort: rt.uiPort,
    basePath: rt.options.basePath,
    otel: rt.otel,
    configured: rt.options.configured,
    autoTrace: rt.options.autoTrace ?? true,
    profiles: Object.fromEntries(
      Object.entries(rt.options.profiles ?? {}).map(([k, v]) => [
        k,
        { description: v.description, headers: Object.keys(v.headers ?? {}) },
      ]),
    ),
  });
});

addRoute("GET", "/api/routes", ({ rt, url, res }) => {
  json(res, 200, rt.discover(url.searchParams.has("fresh")));
});

addRoute("GET", "/api/traces", ({ rt, res }) => {
  json(res, 200, rt.store.list());
});

addRoute("DELETE", "/api/traces", ({ rt, res }) => {
  rt.store.clear();
  json(res, 200, { ok: true });
});

addRoute("GET", "/api/traces/:id", ({ rt, params, res }) => {
  const t = rt.store.get(params.id!);
  if (!t) return json(res, 404, { error: "Trace not found. It may have rotated out." });
  json(res, 200, t);
});

addRoute("GET", "/api/traces/:id/request", ({ rt, params, res }) => {
  const t = rt.store.get(params.id!);
  if (!t) return json(res, 404, { error: "Trace not found" });
  const internal = rt.store.internal(t);
  const headers = { ...(internal?.rawHeaders ?? t.request.headers) };
  for (const h of [
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ]) {
    delete headers[h];
  }
  const body =
    internal?.rawBody ??
    (t.request.body?.json !== undefined ? JSON.stringify(t.request.body.json, null, 2) : t.request.body?.text);
  json(res, 200, { method: t.method, url: t.url, headers, body });
});

addRoute("GET", "/api/source", ({ rt, url, res }) => {
  const file = rt.resolveFile(url.searchParams.get("file") ?? "");
  if (!file) return json(res, 404, { error: "File not found in this project" });
  const all = fs.readFileSync(file, "utf8").split("\n");
  const line = Number(url.searchParams.get("line") || 1);
  const ctx = Number(url.searchParams.get("context") || 10);
  const start = Math.max(1, line - ctx);
  const end = Math.min(all.length, line + ctx);
  json(res, 200, { file: url.searchParams.get("file"), line, start, lines: all.slice(start - 1, end) });
});

addRoute("GET", "/api/events", ({ rt, req, res }) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("event: hello\ndata: {}\n\n");
  const send = (event: string) => (t?: TraceRecord) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(t ? summarize(t) : {})}\n\n`);
  const onStart = send("start");
  const onDone = send("done");
  const onClear = send("clear");
  rt.store.on("start", onStart);
  rt.store.on("done", onDone);
  rt.store.on("clear", onClear);
  const beat = setInterval(() => res.write(": ping\n\n"), 15000);
  const stop = () => {
    clearInterval(beat);
    rt.store.off("start", onStart);
    rt.store.off("done", onDone);
    rt.store.off("clear", onClear);
  };
  req.on("close", stop);
  res.on("error", stop);
});

addRoute("POST", "/api/run", async ({ rt, req, res }) => {
  const input = JSON.parse((await readBody(req)) || "{}");
  await run(rt, input, res);
});

/* -------------------------------------------------------------- entrypoint */

export async function handleUi(rt: Runtime, req: http.IncomingMessage, res: http.ServerResponse) {
  if (!rt.options.allowRemote && !LOOPBACK.has(req.socket.remoteAddress ?? "")) {
    return json(res, 403, {
      error: "Hoplens only answers requests from this machine. Set allowRemote: true to change that.",
    });
  }
  const url = new URL(req.url ?? "/", "http://local");
  const pathname = url.pathname.replace(/^\/__hoplens/, "") || "/";
  const method = req.method ?? "GET";

  const hit = matchRoute(method, pathname);
  if (hit) return hit.route.handler({ rt, req, res, url, method, params: hit.params });
  json(res, 404, { error: `No Hoplens endpoint at ${pathname}` });
}

/* --------------------------------------------------------------- /api/run */

interface RunInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  profile?: string;
}

async function run(rt: Runtime, input: RunInput, res: http.ServerResponse) {
  const port = rt.appPort ?? (Number(process.env.PORT) || 3000);
  if (!input.path || !input.path.startsWith("/")) return json(res, 400, { error: "Path must start with /" });
  const runId = randomUUID();
  const headers: Record<string, string> = {};
  const profile = input.profile ? rt.options.profiles?.[input.profile] : undefined;
  if (input.profile && !profile) return json(res, 400, { error: `Unknown profile "${input.profile}"` });
  for (const [k, v] of Object.entries(profile?.headers ?? {})) headers[k.toLowerCase()] = interpolate(v);
  for (const [k, v] of Object.entries(input.headers ?? {}))
    if (k.trim()) headers[k.trim().toLowerCase()] = interpolate(String(v));
  headers["x-hoplens-run"] = runId;
  const method = (input.method || "GET").toUpperCase();
  const hasBody = input.body !== undefined && input.body !== "" && method !== "GET" && method !== "HEAD";
  if (hasBody && !headers["content-type"])
    headers["content-type"] = /^\s*[[{]/.test(input.body!) ? "application/json" : "text/plain";

  const done = new Promise<TraceRecord | undefined>((resolve) => {
    const timer = setTimeout(() => {
      rt.store.off("done", onDone);
      resolve(rt.store.byRun(runId));
    }, 60000);
    const onDone = (t: TraceRecord) => {
      if (t.runId !== runId) return;
      clearTimeout(timer);
      rt.store.off("done", onDone);
      resolve(t);
    };
    rt.store.on("done", onDone);
  });

  const started = Date.now();
  let status = 0;
  let error: string | undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${input.path}`, {
      method,
      headers,
      body: hasBody ? input.body : undefined,
      redirect: "manual",
    });
    status = r.status;
    await r.arrayBuffer().catch(() => undefined);
  } catch (err: any) {
    error = `Could not reach your app on port ${port}: ${err?.cause?.code ?? err?.message ?? err}`;
  }
  const trace = error ? undefined : await done;
  if (trace) {
    const internal = rt.store.internal(trace);
    if (internal && hasBody) internal.rawBody = input.body;
    if (trace.request.body === undefined && hasBody) {
      trace.request.body = {
        contentType: headers["content-type"],
        size: Buffer.byteLength(input.body!),
        text: input.body!.slice(0, 20000),
      };
      try {
        trace.request.body.json = preview(JSON.parse(input.body!), rt.redactor);
        trace.request.body.text = undefined;
      } catch {
        /* keep text */
      }
    }
  }
  json(res, error ? 502 : 200, { runId, traceId: trace?.id, status, error, elapsed: Date.now() - started });
}

function interpolate(v: string): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
}
