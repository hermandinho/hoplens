// Route templates and handler hops. Patches the app's own express (resolved from its root) through
// its public exports only: express.Route.prototype (methods, all, dispatch), the Router's use(),
// express.application (init, use). Nothing here loads @hoplens/core at import time: the register
// hook installs these patches before user code runs, and core is required only on a traced request.
//
// Every patch is idempotent (a PATCHED mark on the wrapper), calls the original with the arguments
// it was given and returns its value; our own bookkeeping runs in try/catch around it.

import { createRequire } from "node:module";
import path from "node:path";
import type { HopHandle, Runtime } from "@hoplens/core";
import { resolveExpress } from "./resolve";
import { adapterState } from "./state";

const G = globalThis as any;
/** The route template the last dispatched route left on the request (read by tap.describe). */
export const ROUTE_KEY = Symbol.for("hoplens.express.route");
/** On a Route: { [method]: stack } formatted where each method was registered. */
const REG = Symbol.for("hoplens.express.reg");
/** On a Route's REG record: Map<stack, Loc | null>, the mapped location of each of its stacks. */
const LOCS = Symbol.for("hoplens.express.locs");
/** On a router Layer: { path, app? }, the mount path(s) given to use() and the sub-app it mounts. */
const MOUNT = Symbol.for("hoplens.express.mount");
const PATCHED = Symbol.for("hoplens.express.patched");
/** On a response: the handler hops still open, ended on 'finish' / 'close'. */
const OPEN = Symbol.for("hoplens.express.hops");

/** Mount depth walked from an app; deeper routers fall back to req.baseUrl. */
const MAX_DEPTH = 32;
/** Templates kept per route (a router mounted under many prefixes). */
const MAX_PREFIXES = 16;
/** Apps remembered for the walk. */
const MAX_APPS = 256;
/** Registration stacks whose mapped location is shared across routes (routes registered per request). */
const MAX_LOCATIONS = 2048;
/** Templates remembered from dispatch for discovery (routes the walk could not reach). */
const MAX_SEEN = 1024;
/** Routes kept per seen template. */
const MAX_SEEN_ROUTES = 8;

interface Mount {
  path: unknown;
  app?: any;
}

interface Loc {
  file: string;
  line: number;
}

export interface RoutesState {
  major: number;
  /** express.Route.prototype of the patched copy. */
  routeProto?: any;
  apps: Set<WeakRef<object>>;
  /** The apps in `apps`, for an O(1) duplicate check. */
  known: WeakSet<object>;
  /**
   * Express 5 apps whose own code has read their lazy `router` getter: the walk reads it only for
   * these, since the first read builds the router from the app's routing settings of that moment.
   */
  routed: WeakSet<object>;
  /** A change the last walk could see (a use() or route() on a stack it walked, a new app). */
  dirty: boolean;
  /** Route -> mount prefixes it is reachable under, from the last walk. */
  prefixes: WeakMap<object, string[]>;
  /** Router stacks the last walk went through. A use() or route() on any other stack can't change it. */
  walked: WeakSet<object>;
  /**
   * Registration stack -> mapped user location (null: none in the project), shared by routes with the
   * same stack text. Each route also keeps its own (REG[LOCS]), so a full scan never re-maps.
   */
  locations: Map<string, Loc | null>;
  /** The routes the last walk reached, in walk order (discovery lists them). */
  order: WeakRef<object>[];
  /** Template -> routes a traced dispatch gave it, for routes the walk could not reach. */
  seen: Map<string, WeakRef<object>[]>;
}

export function routesState(): RoutesState | undefined {
  return adapterState().routes;
}

/* ------------------------------------------------------------------ install */

/**
 * Where to resolve express from before options are read: HOPLENS_OPTIONS.root, else cwd. Undefined
 * when HOPLENS_OPTIONS says `enabled: false` (boot would not start the runtime either).
 */
export function earlyRoot(env = process.env, cwd = process.cwd()): string | undefined {
  try {
    const o = env.HOPLENS_OPTIONS ? JSON.parse(env.HOPLENS_OPTIONS) : undefined;
    if (o && o.enabled === false) return undefined;
    if (o && typeof o.root === "string" && o.root) return o.root;
  } catch {
    /* resolveOptions reports bad JSON at boot */
  }
  return cwd;
}

/**
 * Patch the express the app resolves from `root`. Requires it (the same module instance the app
 * then gets from Node's cache). Never throws; a second call is a no-op.
 */
export function installRoutes(root: string | undefined = earlyRoot()): RoutesState | undefined {
  const s = adapterState();
  if (s.routes || s.routesFailed || !root) return s.routes;
  try {
    const info = resolveExpress(root);
    if (!info) return undefined;
    const req = createRequire(path.join(root, "package.json"));
    const express = req(path.dirname(info.packageJson));
    const major = Number.parseInt(info.version ?? "", 10) || (typeof express?.Router?.use === "function" ? 4 : 5);
    return patchExpress(express, major);
  } catch {
    s.routesFailed = true;
    return undefined;
  }
}

/** Exported for tests: patch one express module object. */
export function patchExpress(express: any, major: number): RoutesState | undefined {
  const s = adapterState();
  if (s.routes) return s.routes;
  if (!express || typeof express.Router !== "function") return undefined;
  const st: RoutesState = {
    major,
    apps: new Set(),
    known: new WeakSet(),
    routed: new WeakSet(),
    dirty: true,
    prefixes: new WeakMap(),
    walked: new WeakSet(),
    locations: new Map(),
    order: [],
    seen: new Map(),
  };
  const routeProto = routePrototype(express);
  if (!routeProto || typeof routeProto.dispatch !== "function") return undefined;
  st.routeProto = routeProto;
  s.routes = st;

  // (a) registration stacks on Route methods, (d) the dispatch hop.
  for (const key of Object.keys(routeProto)) {
    if (key === "dispatch" || key.startsWith("_") || typeof routeProto[key] !== "function") continue;
    wrap(routeProto, key, (orig) => registrationWrapper(key, orig));
  }
  wrap(routeProto, "dispatch", (orig) => dispatchWrapper(st, orig));

  // (b) mount tags on the Router's use(): v4 keeps its methods on the express.Router function, v5
  // (the `router` package) on Router.prototype.
  const routerProto = major >= 5 ? express.Router.prototype : express.Router;
  wrap(routerProto, "use", (orig) => routerUse(st, orig));
  wrap(routerProto, "route", (orig) => routerRoute(st, orig));

  // (c) app registry, and sub-app tags on app.use(). Apps copy these at creation (merge-descriptors),
  // so only apps created after this patch see them; adoptApp() covers an app made earlier.
  const proto = express.application;
  if (proto) {
    wrap(proto, "init", (orig) => appInit(st, orig));
    wrap(proto, "use", (orig) => appUse(st, orig));
    // Express 4 builds app._router on first use: a sub-app the walk reached before it had one.
    if (typeof proto.lazyrouter === "function") wrap(proto, "lazyrouter", (orig) => appLazyRouter(st, orig));
  }
  return st;
}

type Fn = (...a: any[]) => any;

function registrationWrapper(key: string, orig: Fn): Fn {
  return function (this: any, ...args: any[]) {
    try {
      noteRegistration(this, key);
    } catch {
      /* bookkeeping only */
    }
    return orig.apply(this, args);
  };
}

/**
 * Route#dispatch(req, res, done). Outside a trace: the original, nothing else. Inside one: the
 * route's template goes on the request and a handler hop wraps the original call, ended by the
 * response or by `done` (whose arguments, 'route' and 'router' included, are forwarded as given).
 */
function dispatchWrapper(st: RoutesState, orig: Fn): Fn {
  return function dispatch(this: any, ...args: any[]) {
    const rt: Runtime | undefined = G.__hoplens_runtime;
    if (!rt || rt.isStopped || !rt.currentTrace()) return orig.apply(this, args);
    let opened: { hop: HopHandle; next: unknown } | undefined;
    try {
      opened = openHop(rt, st, this, args[0], args[1], args[2]);
    } catch {
      opened = undefined;
    }
    if (!opened) return orig.apply(this, args);
    const forwarded = args.slice();
    forwarded[2] = opened.next;
    return opened.hop.run(() => orig.apply(this, forwarded));
  };
}

function routerUse(st: RoutesState, orig: Fn): Fn {
  return function use(this: any, ...args: any[]) {
    const before = Array.isArray(this?.stack) ? this.stack.length : -1;
    const out = orig.apply(this, args);
    try {
      if (before >= 0 && Array.isArray(this.stack)) {
        const mount = mountArg(args);
        for (let i = before; i < this.stack.length; i++) {
          const layer = this.stack[i];
          if (layer && !layer[MOUNT]) layer[MOUNT] = { path: mount } satisfies Mount;
          // Express 4: a router built before the patches (hoplens(app), a router required from its
          // own module) still calls the original dispatch it bound at route(); mounting it is the
          // first time we can reach it.
          if (st.major < 5 && isRouter(layer?.handle)) rebindRoutes(st, layer.handle.stack, 0, new Set());
        }
        touch(st, this.stack);
      }
    } catch {
      /* bookkeeping only */
    }
    return out;
  };
}

/** Router#route(path): a new route layer, which the walk must see when it went through this stack. */
function routerRoute(st: RoutesState, orig: Fn): Fn {
  return function route(this: any, ...args: any[]) {
    const out = orig.apply(this, args);
    try {
      touch(st, this?.stack);
    } catch {
      /* bookkeeping only */
    }
    return out;
  };
}

/** The last walk went through `stack`: a change to it needs a new walk. */
function touch(st: RoutesState, stack: unknown): void {
  if (!st.dirty && stack && typeof stack === "object" && st.walked.has(stack)) st.dirty = true;
}

function appInit(st: RoutesState, orig: Fn): Fn {
  return function init(this: any, ...args: any[]) {
    const out = orig.apply(this, args);
    try {
      watchRouter(st, this);
      registerApp(st, this);
    } catch {
      /* bookkeeping only */
    }
    return out;
  };
}

function appLazyRouter(st: RoutesState, orig: Fn): Fn {
  return function lazyrouter(this: any, ...args: any[]) {
    const had = !!this?._router;
    const out = orig.apply(this, args);
    try {
      if (!had && this?._router) st.dirty = true;
    } catch {
      /* bookkeeping only */
    }
    return out;
  };
}

/** Express 5: an app whose lazy `router` getter is not wrapped (it was made before the patches). */
function unwatchedRouter(app: any): boolean {
  const desc = Object.getOwnPropertyDescriptor(app, "router");
  return !!desc && typeof desc.get === "function" && !(desc.get as any)[PATCHED];
}

/**
 * Express 5: the app's `router` is a lazy getter that builds the router from the app's routing
 * settings ('case sensitive routing', 'strict routing') on its first read. Wrap it so the first read
 * by the app's own code marks the app; the walk never reads it for an unmarked app (which has no
 * routes yet anyway). The getter's value and `this` are passed through as they are.
 */
function watchRouter(st: RoutesState, app: any): void {
  if (!app || typeof app.lazyrouter === "function") return;
  const desc = Object.getOwnPropertyDescriptor(app, "router");
  if (!desc || typeof desc.get !== "function" || !desc.configurable || (desc.get as any)[PATCHED]) return;
  const get = desc.get;
  const getter: any = function getrouter(this: unknown) {
    const router = get.call(this);
    try {
      if (!st.routed.has(app)) {
        st.routed.add(app);
        st.dirty = true;
      }
    } catch {
      /* bookkeeping only */
    }
    return router;
  };
  try {
    Object.defineProperty(getter, "name", { value: get.name, configurable: true });
    Object.defineProperty(getter, PATCHED, { value: get });
  } catch {
    /* cosmetic */
  }
  Object.defineProperty(app, "router", { ...desc, get: getter });
}

function appUse(st: RoutesState, orig: Fn): Fn {
  return function use(this: any, ...args: any[]) {
    const out = orig.apply(this, args);
    try {
      tagSubApps(st, this, args);
    } catch {
      /* bookkeeping only */
    }
    return out;
  };
}

/**
 * hoplens(app) for an app created before the patches went in: remember it, tag its own use(), and
 * on Express 4 point routes created earlier at the patched dispatch (Router#route() bound the
 * original). Methods registered before the call have no registration line. Mounts made before the
 * call are untagged: their routes' templates use req.baseUrl with param values put back as names.
 * On Express 4, a sub-app mounted before the call keeps the original dispatch (the mount closure
 * hides it), so its routes get neither a template nor a handler hop.
 */
export function adoptApp(app: any): void {
  const st = routesState();
  if (!st || !app || typeof app !== "function" || typeof app.handle !== "function") return;
  try {
    watchRouter(st, app);
    registerApp(st, app);
    if (typeof app.use === "function" && !app.use[PATCHED] && Object.hasOwn(app, "use")) {
      wrap(app, "use", (orig) => appUse(st, orig));
    }
    // Express 4: the app's own lazyrouter copy (from before the patch) builds app._router unseen.
    if (typeof app.lazyrouter === "function" && Object.hasOwn(app, "lazyrouter")) {
      wrap(app, "lazyrouter", (orig) => appLazyRouter(st, orig));
    }
    if (st.major < 5) rebindRoutes(st, stackOf(st, app), 0, new Set());
    st.dirty = true;
  } catch {
    /* best effort */
  }
}

function rebindRoutes(st: RoutesState, stack: any[] | undefined, depth: number, seen: Set<unknown>): void {
  if (!stack || depth > MAX_DEPTH || seen.has(stack)) return;
  seen.add(stack);
  for (const layer of stack) {
    const route = layer?.route;
    if (route) {
      // A layer bound after the patch already calls it; rebinding that one too is harmless. A route
      // of another express copy keeps its own dispatch.
      if (
        layer.handle?.name === "bound dispatch" &&
        !layer.handle[PATCHED] &&
        Object.getPrototypeOf(route) === st.routeProto
      ) {
        const bound = st.routeProto.dispatch.bind(route);
        bound[PATCHED] = true;
        layer.handle = bound;
      }
    } else if (isRouter(layer?.handle)) rebindRoutes(st, layer.handle.stack, depth + 1, seen);
  }
}

function routePrototype(express: any): any {
  if (typeof express.Route === "function" && express.Route.prototype) return express.Route.prototype;
  // Not exported: a throwaway router's route.
  const r = express.Router();
  return Object.getPrototypeOf(r.route("/"));
}

function wrap(obj: any, key: string, make: (orig: any) => (...a: any[]) => any): void {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  const orig = desc ? desc.value : obj[key];
  if (typeof orig !== "function" || orig[PATCHED]) return;
  const w: any = make(orig);
  try {
    Object.defineProperty(w, "name", { value: orig.name, configurable: true });
    Object.defineProperty(w, "length", { value: orig.length, configurable: true });
    Object.defineProperty(w, PATCHED, { value: orig });
  } catch {
    /* cosmetic */
  }
  if (desc) Object.defineProperty(obj, key, { ...desc, value: w });
  else obj[key] = w;
}

/**
 * Remember an app as a possible walk root. When full: drop collected apps, then the oldest mounted
 * one (the walk reaches it through its parent, or its routes fall back to req.baseUrl); with none,
 * the new app is not remembered, so the apps made first (usually the one serving) stay.
 */
function registerApp(st: RoutesState, app: object): void {
  if (st.known.has(app)) return;
  if (st.apps.size >= MAX_APPS) {
    for (const ref of st.apps) if (!ref.deref()) st.apps.delete(ref);
    if (st.apps.size >= MAX_APPS) {
      let evict: WeakRef<object> | undefined;
      for (const ref of st.apps) {
        if ((ref.deref() as any)?.parent) {
          evict = ref;
          break;
        }
      }
      if (!evict) return;
      st.apps.delete(evict);
      const gone = evict.deref();
      if (gone) st.known.delete(gone);
    }
  }
  st.apps.add(new WeakRef(app));
  st.known.add(app);
  st.dirty = true;
}

function noteRegistration(route: any, key: string): void {
  if (!route || typeof route !== "object") return;
  let reg = route[REG];
  if (!reg) {
    reg = Object.create(null);
    Object.defineProperty(route, REG, { value: reg });
  }
  if (reg[key]) return;
  // Formatted now: an unformatted Error keeps V8's structured frames, and with them every frame's
  // function and receiver (a request, for a route registered while handling one). Mapped lazily.
  const limit = Error.stackTraceLimit;
  try {
    if (!(limit >= 16)) Error.stackTraceLimit = 16;
    reg[key] = String(new Error("hoplens route registration").stack ?? "");
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** The path argument of a use() call, as Express reads it ('/' when the first argument is a fn). */
export function mountArg(args: unknown[]): unknown {
  const fn = args[0];
  if (typeof fn !== "function") {
    let arg: unknown = fn;
    while (Array.isArray(arg) && arg.length !== 0) arg = arg[0];
    if (typeof arg !== "function") return fn;
  }
  return "/";
}

function tagSubApps(st: RoutesState, app: any, args: unknown[]): void {
  const offset = isPathArg(args) ? 1 : 0;
  const fns = (args.slice(offset) as any[]).flat(Number.POSITIVE_INFINITY);
  const stack = stackOf(st, app);
  if (!stack) return;
  touch(st, stack);
  const start = stack.length - fns.length;
  if (start < 0) return;
  const mount = offset ? args[0] : "/";
  fns.forEach((fn, i) => {
    if (!fn || typeof fn.handle !== "function" || typeof fn.set !== "function") return;
    const layer = stack[start + i];
    if (!layer) return;
    if (!layer[MOUNT]) layer[MOUNT] = { path: mount } satisfies Mount;
    layer[MOUNT].app = fn;
    if (typeof fn.lazyrouter === "function") {
      // Express 4: a sub-app built before the patches binds the original dispatch (see routerUse).
      rebindRoutes(st, stackOf(st, fn), 0, new Set());
    } else if (!st.routed.has(fn) && unwatchedRouter(fn)) {
      // Express 5: a sub-app built before the patches, so no read of its lazy `router` was seen.
      // Mounted, its router is read on its first request anyway (and was built already if it has
      // routes), so the walk may read it now.
      watchRouter(st, fn);
      st.routed.add(fn);
    }
    registerApp(st, fn);
  });
}

function isPathArg(args: unknown[]): boolean {
  if (typeof args[0] === "function") return false;
  let arg: unknown = args[0];
  while (Array.isArray(arg) && arg.length !== 0) arg = arg[0];
  return typeof arg !== "function";
}

/**
 * An app's router stack, by the app's own major (it may come from another express copy). Express 4
 * (it has lazyrouter): app._router, never app.router (a throwing deprecation getter). Express 5:
 * app.router only once the app's own code read it (see watchRouter).
 */
function stackOf(st: RoutesState, app: any): any[] | undefined {
  if (!app) return undefined;
  let router: any;
  if (typeof app.lazyrouter === "function") router = app._router;
  else if (st.routed.has(app)) router = app.router;
  return Array.isArray(router?.stack) ? router.stack : undefined;
}

function isRouter(fn: any): boolean {
  return typeof fn === "function" && Array.isArray(fn.stack) && typeof fn.handle === "function";
}

/* --------------------------------------------------------------- dispatch */

function openHop(
  rt: Runtime,
  st: RoutesState,
  route: any,
  req: any,
  res: any,
  done: any,
): { hop: HopHandle; next: any } | undefined {
  const template = templateOf(route, req, st);
  req[ROUTE_KEY] = template;
  noteSeen(st, route, template);
  const method = typeof req.method === "string" ? req.method : "GET";
  const loc = locationOf(st, route, method, rt.root);
  const hop = rt.beginHop("handler", { name: `${method} ${template}`, file: loc?.file, line: loc?.line });
  if (!hop) return undefined;
  trackOnResponse(res, hop);
  if (typeof done !== "function") return { hop, next: done };
  const next = function (this: unknown, ...args: unknown[]) {
    try {
      const err = args[0];
      if (err === undefined || err === null || err === "route" || err === "router") {
        // Left this route without an error, the response not started: a later route (or a 404)
        // owns the request now. A route that responded and then calls next() (audit or logging
        // middleware after it) keeps the request.
        if (req[ROUTE_KEY] === template && !res?.headersSent) req[ROUTE_KEY] = undefined;
        hop.end();
      } else hop.end(err);
    } catch {
      /* bookkeeping only */
    }
    const call = () => done.apply(this, args);
    return typeof hop.exit === "function" ? hop.exit(call) : call();
  };
  return { hop, next };
}

function trackOnResponse(res: any, hop: HopHandle): void {
  if (!res || typeof res.once !== "function") return;
  let open: HopHandle[] | undefined = res[OPEN];
  if (!open) {
    const list: HopHandle[] = [];
    open = list;
    Object.defineProperty(res, OPEN, { value: list, configurable: true });
    const close = () => {
      for (const h of list.splice(0)) {
        try {
          h.end();
        } catch {
          /* idempotent end */
        }
      }
    };
    res.once("finish", close);
    res.once("close", close);
  }
  open.push(hop);
}

let core: typeof import("@hoplens/core") | undefined;

/** Remember which route a traced dispatch grouped under `template`, for discovery. */
function noteSeen(st: RoutesState, route: object, template: string): void {
  let refs = st.seen.get(template);
  if (refs) {
    for (const r of refs) if (r.deref() === route) return;
    if (refs.length >= MAX_SEEN_ROUTES) return;
  } else {
    if (st.seen.size >= MAX_SEEN) {
      const oldest = st.seen.keys().next().value;
      if (oldest !== undefined) st.seen.delete(oldest);
    }
    refs = [];
    st.seen.set(template, refs);
  }
  refs.push(new WeakRef(route));
}

/** A route's registration line for `method` (as the handler hop uses), mapped to the project. */
export function locationOf(st: RoutesState, route: any, method: string, root: string): Loc | undefined {
  const reg = route?.[REG];
  if (!reg) return undefined;
  const m = method.toLowerCase();
  const stack: string | undefined =
    reg[m] ?? (m === "head" ? reg.get : undefined) ?? reg.all ?? reg[Object.keys(reg)[0] ?? ""];
  if (!stack) return undefined;
  let own: Map<string, Loc | null> | undefined = reg[LOCS];
  const mine = own?.get(stack);
  if (mine !== undefined) return mine ?? undefined;
  // Keyed by the stack text: a route registered per request maps its (same) call site once.
  let loc = st.locations.get(stack);
  if (loc === undefined) {
    loc = null;
    try {
      core ??= require("@hoplens/core") as typeof import("@hoplens/core");
      const l = core.mapStack(stack, root).location;
      if (l) loc = { file: l.file, line: l.line };
    } catch {
      /* no location */
    }
    if (st.locations.size >= MAX_LOCATIONS) {
      const oldest = st.locations.keys().next().value;
      if (oldest !== undefined) st.locations.delete(oldest);
    }
    st.locations.set(stack, loc);
  }
  try {
    if (!own) {
      own = new Map();
      Object.defineProperty(reg, LOCS, { value: own });
    }
    own.set(stack, loc);
  } catch {
    /* a frozen record: the shared cache still answers */
  }
  return loc ?? undefined;
}

/* --------------------------------------------------------------- templates */

/**
 * The full template of `route` for this request: its mount prefixes plus its own path. req.baseUrl
 * is the concrete prefix (`/api/users/7`), so prefixes come from walking the registered apps; a
 * route reachable under several prefixes takes the one that segment-matches req.baseUrl.
 */
export function templateOf(route: any, req: any, st: RoutesState | undefined = routesState()): string {
  const major = st?.major ?? 5;
  const own = ownPath(route?.path, String(req?.url ?? "/").split("?")[0] ?? "/", major);
  if (st?.dirty) rebuild(st);
  const prefixes = st?.prefixes.get(route);
  const base = typeof req?.baseUrl === "string" ? req.baseUrl : "";
  if (prefixes?.length === 1) return joinPath(prefixes[0]!, own);
  if (prefixes && prefixes.length > 1) {
    const pick = prefixes.find((p) => segmentsMatch(p, base));
    if (pick !== undefined) return joinPath(pick, own);
  }
  return joinPath(templateBase(base, req?.params), own);
}

/**
 * req.baseUrl as a template, for a route under a mount the walk did not see: segments equal to a
 * param value become `:name` (mergeParams routers see their mount's params), then core's URL
 * normalization collapses the id-like ones left, so each value is not its own route group.
 */
export function templateBase(base: string, params: unknown): string {
  if (!base) return base;
  const byValue = new Map<string, string>();
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (typeof v === "string" && v && !/^\d+$/.test(k) && !byValue.has(v)) byValue.set(v, k);
    }
  }
  let out = base
    .split("/")
    .map((seg) => {
      const name = seg ? byValue.get(decodeSafe(seg)) : undefined;
      return name ? `:${name}` : seg;
    })
    .join("/");
  try {
    core ??= require("@hoplens/core") as typeof import("@hoplens/core");
    out = core.normalizeUrl(out);
  } catch {
    /* names only */
  }
  return out;
}

/** Rebuild route -> prefixes from every registered app that is not itself mounted. */
export function rebuild(st: RoutesState): void {
  st.dirty = false;
  const map = new WeakMap<object, string[]>();
  const walked = new WeakSet<object>();
  const live: any[] = [];
  for (const ref of st.apps) {
    const app = ref.deref();
    if (app) live.push(app);
    else st.apps.delete(ref);
  }
  const reached = new Set<unknown>();
  const order: object[] = [];
  const visit = (app: any, prefixes: string[]) => {
    // One app that can't be walked (a foreign copy, a throwing getter) never voids the others.
    try {
      walk(st, stackOf(st, app), prefixes, 0, new Set(), map, reached, walked, order);
    } catch {
      /* this app's routes fall back to req.baseUrl */
    }
  };
  for (const app of live) if (!app.parent) visit(app, [""]);
  // A sub-app whose mount the walk never saw (made on an app from before the patches): its mount
  // path is the full prefix when its parent is not mounted itself; deeper ones fall back to baseUrl.
  for (const app of live) {
    if (reached.has(app) || !app.parent || app.parent.parent) continue;
    const mounts = ([] as unknown[]).concat(app.mountpath).flat(Number.POSITIVE_INFINITY);
    const prefixes = mounts.filter((m) => typeof m === "string").map((m) => prefixOf("", m, st.major));
    if (prefixes.length) visit(app, prefixes.slice(0, MAX_PREFIXES));
  }
  st.prefixes = map;
  st.walked = walked;
  st.order = order.map((r) => new WeakRef(r));
}

/** A route and the full templates it is listed under. */
export interface RouteEntry {
  route: any;
  templates: string[];
}

/**
 * Every route the walk reaches, with the templates templateOf gives it (one per mount prefix and,
 * for an array path, per element), then routes only seen at dispatch under the templates they got.
 * Walks again when something changed, as templateOf does; never reads a lazy Express 5 router.
 */
export function routeEntries(st: RoutesState): RouteEntry[] {
  if (st.dirty) rebuild(st);
  const out: RouteEntry[] = [];
  const index = new Map<object, RouteEntry>();
  for (const ref of st.order) {
    const route = ref.deref() as any;
    if (!route || index.has(route)) continue;
    const prefixes = st.prefixes.get(route) ?? [""];
    const own = ownPaths(route.path, st.major);
    const templates: string[] = [];
    for (const p of prefixes) for (const o of own) pushUnique(templates, joinPath(p, o));
    const entry = { route, templates };
    index.set(route, entry);
    out.push(entry);
  }
  for (const [template, refs] of st.seen) {
    for (const ref of refs) {
      const route = ref.deref();
      if (!route) continue;
      let entry = index.get(route);
      if (!entry) {
        entry = { route, templates: [] };
        index.set(route, entry);
        out.push(entry);
      }
      pushUnique(entry.templates, template);
    }
  }
  return out;
}

function pushUnique(list: string[], v: string): void {
  if (!list.includes(v)) list.push(v);
}

/** Each path a route answers, as ownPath() would show it for a request matching that path. */
function ownPaths(p: unknown, major: number): string[] {
  if (!Array.isArray(p)) return [displayPath(p, major)];
  const flat = p.flat(Number.POSITIVE_INFINITY);
  return flat.length ? flat.map((el) => displayPath(el, major)) : [""];
}

function prefixOf(prefix: string, mount: unknown, major: number): string {
  const j = joinPath(prefix, displayPath(mount, major));
  return j === "/" ? "" : j;
}

function walk(
  st: RoutesState,
  stack: any[] | undefined,
  prefixes: string[],
  depth: number,
  ancestors: Set<unknown>,
  map: WeakMap<object, string[]>,
  reached: Set<unknown>,
  walked: WeakSet<object>,
  order: object[],
): void {
  if (!stack || depth > MAX_DEPTH || ancestors.has(stack)) return;
  ancestors.add(stack);
  walked.add(stack);
  for (const layer of stack) {
    if (!layer) continue;
    const route = layer.route;
    if (route && typeof route === "object") {
      let list = map.get(route);
      if (!list) {
        map.set(route, (list = []));
        order.push(route);
      }
      for (const p of prefixes) if (list.length < MAX_PREFIXES && !list.includes(p)) list.push(p);
      continue;
    }
    const tag: Mount | undefined = layer[MOUNT];
    let child: any[] | undefined;
    if (tag?.app) {
      reached.add(tag.app);
      child = stackOf(st, tag.app);
    } else if (isRouter(layer.handle)) child = layer.handle.stack;
    // An untagged router (mounted before the patches): its mount is unknown, so its routes fall
    // back to req.baseUrl.
    if (!child || !tag) continue;
    const mounts = ([] as unknown[]).concat(tag.path).flat(Number.POSITIVE_INFINITY);
    const next: string[] = [];
    for (const p of prefixes)
      for (const m of mounts) {
        const joined = prefixOf(p, m, st.major);
        if (next.length < MAX_PREFIXES && !next.includes(joined)) next.push(joined);
      }
    walk(st, child, next, depth + 1, ancestors, map, reached, walked, order);
  }
  ancestors.delete(stack);
}

/** A route's own path for display: a string normalized, a regex as written, an array by the match. */
function ownPath(p: unknown, rel: string, major: number): string {
  if (Array.isArray(p)) {
    const flat = p.flat(Number.POSITIVE_INFINITY);
    for (const el of flat) {
      if (typeof el === "string" && segmentsMatch(displayPath(el, major), rel)) return displayPath(el, major);
      if (el instanceof RegExp && el.test(rel)) return String(el);
    }
    return flat.map((el) => displayPath(el, major)).join(",");
  }
  return displayPath(p, major);
}

function displayPath(p: unknown, major: number): string {
  if (typeof p === "string") return major >= 5 ? normalizeTemplate(p) : p;
  if (p instanceof RegExp) return String(p);
  return String(p ?? "");
}

/**
 * Express 5 (path-to-regexp 8) syntax in the Next-style notation the UI and route keys use (`:x+`
 * one or more segments, `:x*` zero or more): `*splat` -> `:splat+`, an optional wildcard group
 * `{/*rest}` -> `/:rest*`, an optional group `{/:opt}` -> `/:opt?` (`{.json}` -> `(.json)?`).
 */
export function normalizeTemplate(p: string): string {
  let out = p.replace(/\*([A-Za-z_$][\w$]*)/g, ":$1+");
  for (let i = 0; i < 8 && /\{[^{}]*\}/.test(out); i++) {
    out = out.replace(/\{([^{}]*)\}/g, (_m, inner: string) => {
      if (/:[\w$]+\+$/.test(inner)) return `${inner.slice(0, -1)}*`;
      return /:[\w$]+$/.test(inner) ? `${inner}?` : `(${inner})?`;
    });
  }
  return out;
}

export function joinPath(prefix: string, own: string): string {
  const a = prefix.replace(/\/+$/, "");
  if (!own || own === "/") return a || "/";
  return a + (own.startsWith("/") ? own : `/${own}`);
}

/**
 * Whether a template matches a concrete path segment by segment: `:x` matches any one segment, `:x?`
 * may be missing, and a wildcard, group or regex matches the rest.
 */
export function segmentsMatch(template: string, concrete: string): boolean {
  if (/[*+()\\^$|]/.test(template)) return true;
  const t = template.split("/").filter(Boolean);
  const c = concrete.split("/").filter(Boolean);
  if (c.length > t.length) return false;
  for (let i = 0; i < t.length; i++) {
    const seg = t[i]!;
    if (i >= c.length) {
      if (seg.startsWith(":") && seg.endsWith("?")) continue;
      return false;
    }
    if (seg.startsWith(":")) continue;
    if (seg.toLowerCase() !== decodeSafe(c[i]!).toLowerCase()) return false;
  }
  return true;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
