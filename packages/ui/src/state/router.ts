import { signal } from "@preact/signals";

/*
 * Hash router (plan 3.8, contract 4.1). The URL hash is the source of truth for what is on screen:
 *
 *   #/                         overview
 *   #/route/<key>              overview, with that route as the subject (key URI-encoded)
 *   #/requests                 request log
 *   #/r/<traceId>[/s/<spanId>] one trace (optionally a span selected)
 *   #/queries | #/q/<shape>    queries view (optionally one query shape)
 *   #/changes[/e<epoch>]       changes timeline (optionally scrolled to one epoch)
 *   #/cmp/<a>..<b>             compare trace a (baseline) with trace b
 *   ...?since=e<epoch>         any of the above, scoped to "since that edit"
 *
 * The legacy `#trace=<id>` link still opens the trace. Hashes that aren't ours (`#main` from the
 * skip link) parse to null and leave `route` alone.
 *
 * Everyone reads `route` and calls `go()`. Only WP1 (shell) wires `initRouter()` and maps routes
 * onto the store; nothing else writes location.hash.
 */

/** Epoch id as it appears after `e` in the URL (`e7`, later `e3:7` with persistence). */
export type EpochId = string;

export type Route = (
  | { view: "overview"; routeKey?: string }
  | { view: "requests" }
  | { view: "trace"; traceId: string; spanId?: string }
  | { view: "queries"; shape?: string }
  | { view: "changes"; epoch?: EpochId }
  | { view: "compare"; a: string; b: string }
) & {
  /** "Since edit" scope chip; absent = no scope. */
  since?: EpochId;
};

export type RouteView = Route["view"];

const HOME: Route = { view: "overview" };

const enc = encodeURIComponent;

function dec(s: string | undefined): string | undefined {
  if (s === undefined || s === "") return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

/** Parse a location.hash. Returns null for hashes the router doesn't own. Pure. */
export function parseRoute(hash: string): Route | null {
  if (hash.startsWith("#trace=")) {
    const id = dec(hash.slice("#trace=".length));
    return id ? { view: "trace", traceId: id } : null;
  }
  if (hash === "" || hash === "#") return { ...HOME };
  if (!hash.startsWith("#/")) return null;
  const [pathPart = "", queryPart = ""] = hash.slice(2).split("?", 2);
  const parts = pathPart.split("/").filter(Boolean);
  const since = parseEpoch(new URLSearchParams(queryPart).get("since") ?? undefined);
  const withSince = (r: Route): Route => (since ? { ...r, since } : r);
  const [head, a, b, c] = parts;

  switch (head) {
    case undefined:
      return withSince({ view: "overview" });
    case "route": {
      const key = dec(a);
      return withSince(key ? { view: "overview", routeKey: key } : { view: "overview" });
    }
    case "requests":
      return withSince({ view: "requests" });
    case "r": {
      const traceId = dec(a);
      if (!traceId) return withSince({ view: "requests" });
      const spanId = b === "s" ? dec(c) : undefined;
      return withSince(spanId ? { view: "trace", traceId, spanId } : { view: "trace", traceId });
    }
    case "queries":
      return withSince({ view: "queries" });
    case "q": {
      const shape = dec(a);
      return withSince(shape ? { view: "queries", shape } : { view: "queries" });
    }
    case "changes": {
      const epoch = parseEpoch(a);
      return withSince(epoch ? { view: "changes", epoch } : { view: "changes" });
    }
    case "cmp": {
      const [ra, rb] = (a ?? "").split("..", 2);
      const ida = dec(ra);
      const idb = dec(rb);
      return ida && idb ? withSince({ view: "compare", a: ida, b: idb }) : withSince({ view: "requests" });
    }
    default:
      return withSince({ ...HOME });
  }
}

function parseEpoch(s: string | undefined): EpochId | undefined {
  if (!s || s[0] !== "e" || s.length < 2) return undefined;
  return dec(s.slice(1));
}

/** Format a route as a hash (`#/...`). Inverse of parseRoute for every Route. Pure. */
export function formatRoute(r: Route): string {
  let path: string;
  switch (r.view) {
    case "overview":
      path = r.routeKey ? `route/${enc(r.routeKey)}` : "";
      break;
    case "requests":
      path = "requests";
      break;
    case "trace":
      path = `r/${enc(r.traceId)}${r.spanId ? `/s/${enc(r.spanId)}` : ""}`;
      break;
    case "queries":
      path = r.shape ? `q/${enc(r.shape)}` : "queries";
      break;
    case "changes":
      path = r.epoch ? `changes/e${enc(r.epoch)}` : "changes";
      break;
    case "compare":
      path = `cmp/${enc(r.a)}..${enc(r.b)}`;
      break;
  }
  return `#/${path}${r.since ? `?since=e${enc(r.since)}` : ""}`;
}

/** Same screen? Compares the canonical hash, so field order and absent-vs-undefined don't matter. */
export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}

function initial(): Route {
  if (typeof location === "undefined") return { ...HOME };
  return parseRoute(location.hash) ?? { ...HOME };
}

/** What is on screen. Read-only for everyone but this module: navigate with go(). */
export const route = signal<Route>(initial());

export interface GoOptions {
  /** Replace the history entry instead of pushing one (selection under Follow, typing). */
  replace?: boolean;
}

/**
 * Navigate. Pushes a history entry (Back works) unless `replace`. Updates `route` synchronously;
 * the hashchange that follows is a no-op. No-op when already there.
 */
export function go(next: Route, opts: GoOptions = {}): void {
  if (sameRoute(route.value, next)) return;
  route.value = next;
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const hash = formatRoute(next);
  if (location.hash === hash) return;
  if (opts.replace) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
}

/** Keep the current view, change only the since scope (`undefined` clears it). */
export function setSince(since: EpochId | undefined, opts: GoOptions = { replace: true }): void {
  const { since: _old, ...rest } = route.value;
  go((since ? { ...rest, since } : rest) as Route, opts);
}

/**
 * Follow Back/Forward and manual hash edits. Call once from the shell; returns a disposer.
 * pushState doesn't fire hashchange, so popstate covers Back/Forward after go().
 */
export function initRouter(): () => void {
  const sync = () => {
    const r = parseRoute(location.hash);
    if (!r) return;
    // A legacy `#trace=<id>` link is rewritten to its canonical `#/r/<id>` in place.
    if (location.hash.startsWith("#trace=")) history.replaceState(null, "", formatRoute(r));
    if (!sameRoute(r, route.value)) route.value = r;
  };
  sync();
  window.addEventListener("hashchange", sync);
  window.addEventListener("popstate", sync);
  return () => {
    window.removeEventListener("hashchange", sync);
    window.removeEventListener("popstate", sync);
  };
}
