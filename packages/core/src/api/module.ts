import type http from "node:http";
import type { Runtime } from "../runtime";

/*
 * Per-endpoint module contract (plan 4.1). Every new UI-server endpoint lives in its own file,
 * `src/api/<name>.ts`, that exports `endpoints: ApiEndpoint[]` (usually one entry whose `handle`
 * is also exported as `handle`). server.ts imports the module and lists it in `API_MODULES`, which
 * is the only line a work package adds there.
 *
 *   // src/api/health.ts
 *   export function handle(req, res, rt, ctx) { sendJson(res, 200, rt.health.snapshot()); }
 *   export const endpoints: ApiEndpoint[] = [{ method: "GET", path: "/api/health", handle }];
 *
 * Paths are relative to the /__hoplens mount and may contain `:name` params (`/api/compare/:a`).
 * Handlers only run for loopback callers (handleUi checks allowRemote first) and never on the app's
 * request path, so they may do real work, but must not keep timers alive after `req` closes.
 */

export type ApiMethod = "GET" | "POST" | "DELETE";

export interface ApiContext {
  /** Parsed request URL (search params live here). */
  url: URL;
  method: string;
  /** Decoded `:name` segments of the matched path. */
  params: Record<string, string>;
}

export type ApiHandle = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rt: Runtime,
  ctx: ApiContext,
) => void | Promise<void>;

export interface ApiEndpoint {
  method: ApiMethod;
  path: string;
  handle: ApiHandle;
}

export interface ApiModule {
  endpoints: readonly ApiEndpoint[];
  /**
   * Optional: runs once per Runtime from `Runtime.start()` (via `startApiModules`), for state that
   * must observe the app from the start rather than from the first UI call. Must stay cheap and
   * must not throw; never on the request path.
   */
  start?: (rt: Runtime) => void;
}

/** JSON response, never cached. Same headers as the built-in endpoints. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Request body as UTF-8 text; throws past `limit` bytes (default 5 MB). */
export async function readBody(req: http.IncomingMessage, limit = 5 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parsed JSON body (`{}` when empty). Throws SyntaxError on malformed JSON. */
export async function readJson<T = unknown>(req: http.IncomingMessage, limit?: number): Promise<T> {
  const text = await readBody(req, limit);
  return (text ? JSON.parse(text) : {}) as T;
}
