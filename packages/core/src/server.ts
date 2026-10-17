import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import * as compareApi from "./api/compare";
import * as epochsApi from "./api/epochs";
import * as healthApi from "./api/health";
import type { ApiModule } from "./api/module";
import type { QueryKind } from "./queries";
import { type QueryTarget, inSinceScope, matchQuery, parseQuery, parseSinceParam } from "./query";
import {
  type RunInput,
  RunInputError,
  batchHttpStatus,
  parseFlag,
  parseRepeat,
  prepareRun,
  runBatch,
  runOnce,
} from "./replay";
import type { Runtime } from "./runtime";
import { summarize } from "./store";
import type { BodyCapture, TraceRecord } from "./types";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
let uiCache: { mtimeMs: number; html: string } | null = null;
let uiPathCache: string | null = null;

function resolveUiPath(): string | null {
  if (uiPathCache && fs.existsSync(uiPathCache)) return uiPathCache;
  // Adapters (e.g. @hoplens/next) resolve the UI path at config-eval time and set this env var,
  // because bundlers (Turbopack) rewrite __dirname / require.resolve to sentinels like `/ROOT/`
  // and `[project]` which don't survive path.join at runtime.
  const fromEnv = process.env.HOPLENS_UI_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return (uiPathCache = fromEnv);
  // Non-bundled callers (plain Node, Nest, Express later) can still rely on require.resolve.
  try {
    const uiRoot = path.dirname(require.resolve("@hoplens/ui/package.json"));
    const candidates = [path.join(uiRoot, "dist", "index.html"), path.join(uiRoot, "index.html")];
    for (const f of candidates) if (fs.existsSync(f)) return (uiPathCache = f);
  } catch {
    /* fall through to the error page */
  }
  return null;
}

function uiHtml(): string {
  const file = resolveUiPath();
  if (!file) {
    return "<!doctype html><title>Hoplens</title><p>UI bundle missing. Reinstall @hoplens/core, or build @hoplens/ui.</p>";
  }
  const stat = fs.statSync(file);
  if (!uiCache || uiCache.mtimeMs !== stat.mtimeMs) {
    uiCache = { mtimeMs: stat.mtimeMs, html: fs.readFileSync(file, "utf8") };
  }
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
  const framework = rt.framework;
  try {
    appName = JSON.parse(fs.readFileSync(path.join(rt.root, "package.json"), "utf8")).name;
    // Other adapters report their own version through `framework`; only Next's keeps the `next` field.
    if (!framework || framework.name === "next") {
      nextVersion = JSON.parse(
        fs.readFileSync(require.resolve("next/package.json", { paths: [rt.root] }), "utf8"),
      ).version;
    }
  } catch {
    /* optional */
  }
  json(res, 200, {
    app: appName,
    next: nextVersion,
    framework,
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

addRoute("GET", "/api/traces", ({ rt, url, res }) => {
  const q = url.searchParams.get("q");
  // `?since=<epoch>` (or e<n>): only requests in epochs >= since, with or without `q`.
  const since = parseSinceParam(url.searchParams.get("since"));
  if (!q || !q.trim()) {
    const list = rt.store.list();
    return json(res, 200, since === undefined ? list : list.filter((t) => inSinceScope(t, since)));
  }
  // Same array shape as the unfiltered list; dropped terms are reported in a header so the UI can
  // flag them without a second request.
  const query = parseQuery(q);
  const out = rt.store
    .records()
    .filter((t) => inSinceScope(t, since) && matchQuery(query, recordTarget(t)))
    .map(summarize);
  res.setHeader("x-hoplens-query-errors", encodeURIComponent(JSON.stringify(query.errors)));
  json(res, 200, out);
});

addRoute("GET", "/api/stats", ({ rt, url, res }) => {
  json(
    res,
    200,
    rt.stats.snapshot({
      buckets: url.searchParams.get("buckets") === "1",
      since: parseSinceParam(url.searchParams.get("since")),
    }),
  );
});

addRoute("GET", "/api/queries", ({ rt, url, res }) => {
  const kind = url.searchParams.get("kind");
  const limit = Number(url.searchParams.get("limit"));
  json(
    res,
    200,
    rt.queries.snapshot({
      kind: kind === "db" || kind === "cache" || kind === "fetch" ? (kind as QueryKind) : undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      retained: (id) => rt.store.get(id) !== undefined,
    }),
  );
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
  const onUpdate = send("update");
  const onClear = send("clear");
  rt.store.on("start", onStart);
  rt.store.on("done", onDone);
  rt.store.on("update", onUpdate);
  rt.store.on("clear", onClear);
  // WP6: process health (`event: health`, HealthTick) on the same stream, first one right away.
  const detachHealth = healthApi.attachHealthEvents(
    rt.health,
    (chunk) => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    },
    healthApi.HEALTH_EVENT_MIN_GAP_MS,
    { immediate: true },
  );
  const beat = setInterval(() => res.write(": ping\n\n"), 15000);
  const stop = () => {
    clearInterval(beat);
    detachHealth();
    rt.store.off("start", onStart);
    rt.store.off("done", onDone);
    rt.store.off("update", onUpdate);
    rt.store.off("clear", onClear);
  };
  req.on("close", stop);
  res.on("error", stop);
});

addRoute("POST", "/api/run", async ({ rt, req, res, url }) => {
  let input: RunInput;
  try {
    input = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return json(res, 400, { error: "Body must be JSON" });
  }
  await run(rt, input, res, url);
});

/* ------------------------------------------------ per-endpoint modules (plan 4.1) */

/**
 * Endpoints that live in their own `src/api/<name>.ts` module (contract in api/module.ts). A work
 * package adds exactly one import above and one entry here; nothing else in this file changes.
 * Mounted after the built-in routes, so a module can't shadow an existing endpoint.
 */
const API_MODULES: readonly ApiModule[] = [healthApi, compareApi, epochsApi];

/** Mount a per-endpoint module. Exported for tests; production modules go in API_MODULES. */
export function mountApi(mod: ApiModule): void {
  for (const ep of mod.endpoints) {
    addRoute(ep.method, ep.path, ({ rt, req, res, url, method, params }) =>
      ep.handle(req, res, rt, { url, method, params }),
    );
  }
}

for (const mod of API_MODULES) mountApi(mod);

/** Run each module's `start` hook once for a runtime (Runtime.start calls this). Never throws. */
export function startApiModules(rt: Runtime): void {
  for (const mod of API_MODULES) {
    try {
      mod.start?.(rt);
    } catch {
      /* a module's background state is best effort */
    }
  }
}

/* ------------------------------------------------------------------ search */

function bodyText(b: BodyCapture | undefined): string | undefined {
  if (!b) return undefined;
  if (b.text !== undefined) return b.text;
  if (b.json === undefined) return undefined;
  try {
    return JSON.stringify(b.json);
  } catch {
    return undefined;
  }
}

/**
 * Server-side search target. Free text covers path, url, route, error message, logs and the captured
 * (already redacted) request/response bodies; the expensive sources are thunks, only evaluated when the
 * cheaper ones didn't match.
 */
export function recordTarget(t: TraceRecord): QueryTarget {
  return {
    method: t.method,
    path: t.path,
    route: t.route,
    kind: t.kind,
    status: t.done ? t.status : undefined,
    duration: t.duration,
    cold: t.facts?.cold,
    rules: t.findings?.map((f) => f.rule),
    error: !!t.error,
    text: [
      t.url,
      t.route,
      t.error?.message,
      () => t.logs.map((l) => l.text).join("\n"),
      () => bodyText(t.request.body),
      () => bodyText(t.response.body),
    ],
  };
}

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

/**
 * One run (legacy shape `{runId, traceId, status, error, elapsed}`), or Replay xN when `repeat` is
 * given in the query (`?repeat=N`) or body (WP7): see replay.ts for the batch response.
 */
async function run(rt: Runtime, input: RunInput, res: http.ServerResponse, url?: URL) {
  try {
    const repeat = parseRepeat(url?.searchParams.get("repeat") ?? input.repeat);
    if (repeat) {
      const keepGoing = parseFlag(url?.searchParams.get("keepGoing") ?? input.keepGoing);
      const r = await runBatch(rt, { ...input, keepGoing }, repeat);
      return json(res, batchHttpStatus(r), r);
    }
    const r = await runOnce(rt, prepareRun(rt, input));
    json(res, r.error ? 502 : 200, {
      runId: r.runId,
      traceId: r.trace?.id,
      status: r.status,
      error: r.error,
      elapsed: r.elapsed,
    });
  } catch (err) {
    if (err instanceof RunInputError) return json(res, 400, { error: err.message });
    throw err;
  }
}
