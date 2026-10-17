// Route discovery: the route list behind /__hoplens/api/routes. Built from the same walk and the same
// templates routes.ts gives traces (so RouteInfo.nextRoute === TraceRecord.route), plus the routes
// a traced dispatch reached that the walk could not. Core calls scan() throttled; it never throws.

import fs from "node:fs";
import path from "node:path";
import type { Discovery, DiscoverySource, MethodInfo, RouteInfo } from "@hoplens/core";
import { type RouteEntry, locationOf, routeEntries, routesState } from "./routes";

/** Methods whose requests the builder seeds with a body. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
/** Routes listed at most (a route registered per request, say). */
const MAX_ROUTES = 2000;

export class ExpressDiscoverySource implements DiscoverySource {
  constructor(private readonly root: string) {}

  scan(): Discovery {
    const scannedAt = Date.now();
    let typescript = false;
    try {
      typescript = fs.existsSync(path.join(this.root, "tsconfig.json"));
    } catch {
      /* not TypeScript, then */
    }
    let routes: RouteInfo[] = [];
    try {
      const st = routesState();
      if (st) routes = discoverRoutes(routeEntries(st), (route, method) => locationOf(st, route, method, this.root));
    } catch {
      routes = [];
    }
    return { routes, typescript, scannedAt };
  }
}

type Locate = (route: any, method: string) => { file: string; line: number } | undefined;

interface Group {
  info: RouteInfo;
  methods: Set<string>;
}

/**
 * One RouteInfo per template and registration file: the methods of every route with that template
 * (app.get('/x') and app.post('/x') are two routes) merge, each with its own registration line. A
 * template whose methods were registered in different files is listed once per file. Exported for tests.
 */
export function discoverRoutes(entries: RouteEntry[], locate: Locate): RouteInfo[] {
  const groups = new Map<string, Group>();
  const out: RouteInfo[] = [];
  for (const { route, templates } of entries) {
    const methods = methodsOf(route);
    if (!methods.length) continue;
    const located = methods.map((m) => ({ method: m, loc: safeLocate(locate, route, m) }));
    for (const template of templates) {
      for (const { method, loc } of located) {
        const file = loc?.file ?? "";
        const key = `${template}\n${file}`;
        let g = groups.get(key);
        if (!g) {
          if (out.length >= MAX_ROUTES) continue;
          const sameTemplate = out.filter((r) => r.nextRoute === template).length;
          g = { info: routeInfo(template, file, sameTemplate, isRegex(route, template)), methods: new Set() };
          groups.set(key, g);
          out.push(g.info);
        }
        if (g.methods.has(method)) continue;
        g.methods.add(method);
        g.info.methods.push({
          method,
          line: loc?.line ?? 0,
          schemas: [],
          readsBody: BODY_METHODS.has(method),
        } satisfies MethodInfo);
      }
    }
  }
  return out;
}

function safeLocate(locate: Locate, route: any, method: string) {
  try {
    return locate(route, method);
  } catch {
    return undefined;
  }
}

/** Methods every app.all() registers, among the ~30 of Node's list it registers one by one. */
const ALL_CORE = ["get", "post", "put", "delete", "patch", "head", "options"];
const ALL_MIN = 20;

/**
 * A route's registered methods, upper-cased, in registration order. `route.all()` (`_all`) and
 * `app.all()` (which registers every method of Node's list on the route) are `ANY`.
 */
export function methodsOf(route: any): string[] {
  const m = route?.methods;
  if (!m || typeof m !== "object") return [];
  const keys = Object.keys(m).filter((k) => m[k]);
  if (keys.includes("_all") || (keys.length >= ALL_MIN && ALL_CORE.every((k) => m[k]))) return ["ANY"];
  const out: string[] = [];
  for (const key of Object.keys(m)) {
    if (!m[key]) continue;
    const name = key === "_all" ? "ANY" : key.toUpperCase();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Whether `template` ends in one of the route's regex paths (shown as written, no named params). */
function isRegex(route: any, template: string): boolean {
  const p = route?.path;
  const els = Array.isArray(p) ? p.flat(Number.POSITIVE_INFINITY) : [p];
  return els.some((el) => el instanceof RegExp && template.endsWith(String(el)));
}

function routeInfo(template: string, file: string, n: number, regex: boolean): RouteInfo {
  // The builder keys a pick as `${id}::${method}`: an id never contains "::".
  const base = template.replaceAll("::", ":%3A");
  const path = regex ? template : builderPath(template);
  const kept = new Set(paramsOf(path).map((p) => p.name));
  return {
    id: n === 0 ? `express ${base}` : `express ${base} (${file || n})`,
    router: "express",
    path,
    nextRoute: template,
    file,
    // From the template (`:x?` is optional, not catch-all), minus any an optional group dropped.
    params: regex ? [] : paramsOf(template).filter((p) => kept.has(p.name)),
    methods: [],
  };
}

/**
 * The template in the notation the request builder fills (`:x`, `:x+`, `:x*`): a param's regex is
 * dropped (`:id(\\d+)` -> `:id`) and an optional param becomes zero-or-more (`:x?` -> `:x*`), since
 * the builder reads a trailing `?` as the query string. Every other pattern character is turned into
 * the shortest literal path that matches: an optional group (`(.json)?`, from Express 5 `{.json}`) is
 * dropped, and Express 4's `b?` / `b+` / `*` become `` / `b` / ``. Exported for tests.
 */
export function builderPath(template: string): string {
  const s = template.replace(/(:[A-Za-z_$][\w$]*)\((?:\\.|[^()\\])*\)/g, "$1").replace(/(:[A-Za-z_$][\w$]*)\?/g, "$1*");
  return literalPath(s, 0);
}

function literalPath(s: string, depth: number): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    const param = c === ":" ? /^:[A-Za-z_$][\w$]*[+*]?/.exec(s.slice(i)) : null;
    if (param) {
      out += param[0];
      i += param[0].length;
      continue;
    }
    if (c === "\\") {
      out += s[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === "(") {
      const end = closing(s, i);
      if (end < 0) return out + s.slice(i);
      const mod = s[end + 1];
      if (mod === "?" || mod === "*") i = end + 2;
      else {
        out += depth < 8 ? literalPath(s.slice(i + 1, end), depth + 1) : s.slice(i + 1, end);
        i = end + (mod === "+" ? 2 : 1);
      }
      continue;
    }
    const mod = s[i + 1];
    if (c === "*" || c === "?") i += 1;
    else if (mod === "?") i += 2;
    else if (mod === "+" || mod === "*") {
      out += c;
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The named params of a template (`:x`, `:x?`, `:x+`, `:x*`, with or without a regex). Exported for tests. */
export function paramsOf(template: string): RouteInfo["params"] {
  const out: RouteInfo["params"] = [];
  const re = /:([A-Za-z_$][\w$]*)(?:\((?:\\.|[^()\\])*\))?([?*+])?/g;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    const name = m[1]!;
    if (out.some((p) => p.name === name)) continue;
    const mod = m[2];
    out.push({ name, catchAll: mod === "+" || mod === "*", optional: mod === "?" || mod === "*" });
  }
  return out;
}
