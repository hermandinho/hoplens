import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpTap } from "@hoplens/core";
import type { Env } from "./gate";
import { ignoredPrefixes } from "./options";

/** Response types counted as static assets when no route handled the request. */
const ASSET_TYPE =
  /^(text\/css|text\/javascript|application\/(x-)?javascript|image\/|font\/|application\/(x-)?font|application\/vnd\.ms-fontobject)/i;
/** A 304 carries no content-type (`send` strips it), so it falls back to the extension. */
const ASSET_EXT = /\.(css|m?js|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot)$/i;

/**
 * Express's HttpTap: nothing framework-internal to skip but the browser's own probes, every request
 * is a `route` request, and request events stay bound to the trace (body-parser continues the
 * handler from the request's 'end').
 */
export function createTap(
  normalizeUrl: (url: string) => string,
  env: Env = process.env,
  expressVersion?: string,
): HttpTap {
  const strictEmpty = !(Number.parseInt(expressVersion ?? "", 10) >= 5);
  return {
    internalPrefixes: ["/favicon.ico", "/.well-known/", ...ignoredPrefixes(env)],
    classifyRequest: () => "route",
    bindRequestEmitter: true,
    describe: (req, res) => describeRequest(req, res, normalizeUrl),
    requestBody: (req) => requestBody(req, strictEmpty),
  };
}

/**
 * No route is dispatched yet (route templates arrive with the router patch), so core groups requests
 * by normalized URL. A static file is tagged `asset`; core applies a kind only alongside a route, so
 * it carries the normalized path core would group it under anyway.
 */
export function describeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  normalizeUrl: (url: string) => string,
): { route?: string; kind?: "asset" } | undefined {
  const status = res.statusCode;
  if (status !== 200 && status !== 304) return undefined;
  const pathname = String((req as any).originalUrl ?? req.url ?? "/").split(/[?#]/)[0] || "/";
  const type = String(res.getHeader("content-type") ?? "");
  const asset = type ? ASSET_TYPE.test(type) : status === 304 && ASSET_EXT.test(pathname);
  if (!asset) return undefined;
  return { route: normalizeUrl(pathname), kind: "asset" };
}

/**
 * The body a parser left on `req.body`. express.json() leaves `{}` (Express 4) or nothing (5) on a
 * request without one, so only a request that declared a body (content-length > 0, or chunked) counts.
 *
 * body-parser 1.x (Express 4) also sets `req.body = req.body || {}` before it checks the content type,
 * and leaves that `{}` behind when no parser matched or the parse failed. An empty plain object is
 * kept only when a parser read the stream (`req._body`, set on body-parser's read path) and the body
 * could really have been `{}`: two bytes, or a request that did not fail. body-parser 2.x (Express 5)
 * leaves no stray `{}` and sets no `_body`, so `strictEmpty` is off only for a resolved Express >= 5.
 */
export function requestBody(
  req: IncomingMessage,
  strictEmpty = true,
): { contentType?: string; value: unknown } | undefined {
  const value = (req as any).body;
  if (value === undefined || value === null) return undefined;
  const length = Number(req.headers["content-length"]);
  const chunked = req.headers["transfer-encoding"] !== undefined;
  if (!(length > 0) && !chunked) return undefined;
  if (strictEmpty && isEmptyPlainObject(value)) {
    if ((req as any)._body !== true) return undefined;
    const status = Number((req as any).res?.statusCode);
    if (length !== 2 && status >= 400) return undefined;
  }
  const ct = req.headers["content-type"];
  return { contentType: typeof ct === "string" ? ct : undefined, value };
}

function isEmptyPlainObject(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return (proto === Object.prototype || proto === null) && Object.keys(v).length === 0;
}
