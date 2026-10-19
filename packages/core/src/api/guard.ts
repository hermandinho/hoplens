// The one gate in front of every UI route (handleUi runs it before routing, so a route added to
// server.ts or an api/ module cannot skip it).
//
// Threat: a web page in the user's browser. The API reads captured traffic (bodies, raw cookies and
// authorization headers, source files) and POST /api/run sends requests into the app, so:
//   - DNS rebinding: attacker.example re-resolves to 127.0.0.1; the browser then treats the API as
//     same-origin with the attacker's page and sends no Origin on GET / EventSource. Only the Host
//     header (attacker.example:<port>) gives it away, so Host must name this machine. Next's
//     fallback rewrite proxies with changeOrigin (Host becomes 127.0.0.1:<port>), so a forwarded
//     host (x-forwarded-host) must name this machine too. The Vite dev proxy (ui/vite.config.ts)
//     sets it the same way. Known gap: a proxy connects from loopback and Next's sends no
//     x-forwarded-for, so for a request served by that rewrite (not the in-process emit hook in
//     capture.ts) the client-address check sees 127.0.0.1; only the Host checks apply there.
//   - CSRF from another site: a cross-origin page can send "simple" requests without a CORS
//     preflight. A present Origin must be loopback (any port: the Vite dev server on :5173 and the
//     app-port mount are both fine), and a state-changing request from a browser must say
//     `content-type: application/json`, which is never simple. That forces a preflight even for a
//     page on another localhost port, and the API answers no CORS headers, so the browser stops
//     there. Bodies sent as text/plain, form-urlencoded or multipart are refused outright (415).
//     Requests with no Origin (node fetch, curl, Playwright's request context) are not browser
//     page requests and only need a body-less call or a JSON content type.
//
// allowRemote: true keeps its old meaning (any client address, any Host, so a LAN address or
// name.local works). Rebinding protection is then off by design: a Host allowlist cannot tell a
// rebound name from a LAN name. What stays: a present Origin must be loopback or the same host as
// the request (blocks cross-site CSRF), plus the content-type rule. Remote mode needs its own
// protection (a trusted network, a reverse proxy with auth).
//
// Hostnames are matched in their canonical form only: browsers always send `127.0.0.1`, never
// `2130706433`, `0x7f.1` or `0177.0.0.1`, so those (and anything else non-canonical) are refused.

import type http from "node:http";

export interface GuardRequest {
  method?: string;
  socket: { remoteAddress?: string; localPort?: number };
  headers: http.IncomingHttpHeaders | Record<string, unknown>;
}

export type GuardRefusal = { status: 403 | 415; body: { code: "forbidden" | "content-type"; error: string } };

const V4_LOOPBACK = /^127\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

function v4Loopback(ip: string): boolean {
  const m = V4_LOOPBACK.exec(ip);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** Socket peer is this machine (127.0.0.0/8, ::1, or an IPv4-mapped 127.x). */
export function loopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1") return true;
  return v4Loopback(a.startsWith("::ffff:") ? a.slice(7) : a);
}

/** `host[:port]` split into a lowercased hostname (IPv6 without brackets) and port; null if malformed. */
function splitAuthority(authority: string): { host: string; port: string; v6: boolean } | null {
  const s = authority.trim().toLowerCase();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end < 0) return null;
    const rest = s.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    const host = s.slice(1, end);
    if (!/^[0-9a-f:.]+$/.test(host)) return null;
    return { host, port: rest.slice(1), v6: true };
  }
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  let host = m[1]!;
  if (host.endsWith(".")) host = host.slice(0, -1); // one trailing dot: the FQDN form
  if (!host || host.startsWith(".") || host.includes("..")) return null;
  return { host, port: m[2] ?? "", v6: false };
}

/** A Host-header value (`host[:port]`, any port) that names this machine. */
export function loopbackAuthority(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const a = splitAuthority(value);
  if (!a) return false;
  if (a.v6) return a.host === "::1";
  return a.host === "localhost" || a.host.endsWith(".localhost") || v4Loopback(a.host);
}

/** `scheme://authority` of an Origin header, or null (`null`, a path, a list, anything else). */
function parseOrigin(value: string): { scheme: string; authority: string } | null {
  const m = /^(https?):\/\/([^/?#\s,@\\]+)$/i.exec(value.trim());
  return m ? { scheme: m[1]!.toLowerCase(), authority: m[2]! } : null;
}

/** An Origin header value whose page is on this machine (http/https, loopback host, any port). */
export function loopbackOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const o = parseOrigin(value);
  return !!o && loopbackAuthority(o.authority);
}

/** Origin names the same host and port as `authority` (a Host or forwarded host value). */
function sameHost(origin: string, authority: string): boolean {
  const o = parseOrigin(origin);
  const oa = o && splitAuthority(o.authority);
  const ha = splitAuthority(authority);
  if (!o || !oa || !ha) return false;
  const dflt = o.scheme === "https" ? "443" : "80";
  return oa.host === ha.host && (oa.port || dflt) === (ha.port || dflt);
}

function header(req: GuardRequest, name: string): string | undefined {
  const v = (req.headers as Record<string, unknown>)[name];
  if (Array.isArray(v)) return v.join(", ");
  return typeof v === "string" ? v : undefined;
}

function forwardedHosts(req: GuardRequest): string[] {
  const v = header(req, "x-forwarded-host");
  return v === undefined ? [] : v.split(",").map((s) => s.trim());
}

function openAt(req: GuardRequest): string {
  const port = req.socket.localPort;
  return `Open Hoplens at http://localhost${port ? `:${port}` : ""}/__hoplens`;
}

function forbidden(error: string): GuardRefusal {
  return { status: 403, body: { code: "forbidden", error } };
}

/**
 * Who may call: client address, Host (and forwarded host) and Origin. `allowRemote` relaxes the
 * first two and widens Origin to same-host (see the header comment). Undefined = allowed.
 */
export function callerRefusal(req: GuardRequest, allowRemote: boolean): GuardRefusal | undefined {
  const host = header(req, "host");
  const origin = header(req, "origin");
  if (!allowRemote) {
    if (!loopbackAddress(req.socket.remoteAddress))
      return forbidden(
        "Hoplens only answers requests from this machine. Set allowRemote: true to change that (then protect that port yourself).",
      );
    if (!loopbackAuthority(host))
      return forbidden(
        `Hoplens refused this request: Host ${JSON.stringify(host ?? "")} is not this machine (a DNS rebinding guard). ${openAt(req)}, or set allowRemote: true to serve it under other names.`,
      );
    const fwd = forwardedHosts(req).find((h) => !loopbackAuthority(h));
    if (fwd !== undefined)
      return forbidden(
        `Hoplens refused this request: it was forwarded for ${JSON.stringify(fwd)}, which is not this machine (a DNS rebinding guard). ${openAt(req)}.`,
      );
  }
  if (origin !== undefined && !loopbackOrigin(origin)) {
    const same = allowRemote && [host, ...forwardedHosts(req)].some((h) => h !== undefined && sameHost(origin, h));
    if (!same)
      return forbidden(
        `Hoplens refused a request from the page at ${JSON.stringify(origin)}: only pages on this machine (localhost, 127.0.0.1, [::1]) may call its API. ${openAt(req)}.`,
      );
  }
  return undefined;
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function jsonType(ct: string): boolean {
  const mime = ct.split(";")[0]!.trim().toLowerCase();
  return mime === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(mime);
}

/**
 * State-changing requests: a content type, when there is one, must be JSON; a browser request
 * (it carries Origin) must have one even with no body, so a cross-origin page can't send it
 * without a preflight. Undefined = allowed.
 */
export function bodyRefusal(req: GuardRequest): GuardRefusal | undefined {
  if (!STATE_CHANGING.has((req.method ?? "GET").toUpperCase())) return undefined;
  const ct = header(req, "content-type");
  const fromPage = header(req, "origin") !== undefined;
  if (ct === undefined ? !fromPage : jsonType(ct)) return undefined;
  return {
    status: 415,
    body: {
      code: "content-type",
      error:
        ct === undefined
          ? "Hoplens API calls that change state must send content-type: application/json (a cross-site guard)."
          : `Hoplens API calls that change state must send content-type: application/json, not ${JSON.stringify(ct)} (a cross-site guard).`,
    },
  };
}

/** The full gate handleUi runs before every route. Undefined = allowed. */
export function guardRequest(req: GuardRequest, opts: { allowRemote?: boolean } = {}): GuardRefusal | undefined {
  return callerRefusal(req, !!opts.allowRemote) ?? bodyRefusal(req);
}

/**
 * The strict caller check (loopback address, Host, forwarded host, Origin) whatever allowRemote
 * says: for endpoints that write files (the request path switch), which allowRemote never widens.
 */
export function trustedCaller(req: GuardRequest): boolean {
  return callerRefusal(req, false) === undefined;
}
