// Function hops before boot. The transform trailer (@hoplens/transform) reads
// `globalThis.__hoplens.wrap` once, while its module evaluates, and does nothing when it is missing.
// Core only sets the real wrap in Runtime.start(), at the app's first listen, long after the app's
// modules ran. So the register hook installs this core-free shim first: each wrapped function becomes
// a forwarder that calls the original until boot, then binds once to core's wrap (bindFnShim).
//
// Calls shaped like Express middleware or handlers, (req, res[, next]) or (err, req, res, next), pass
// straight through: they already have their route's handler hop (routes.ts), and a middleware's span
// would end at next(), not when its work does.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Env } from "./gate";
import { type AutoTraceStats, adapterState } from "./state";

const G = globalThis as any;
const KEY = Symbol.for("hoplens.express.fnshim");

export interface WrapMeta {
  name: string;
  file: string;
  line: number;
}

export type WrapFn = (fn: any, meta: WrapMeta) => any;

interface ShimState {
  /** Core's wrap, once bound. */
  real?: WrapFn;
  wrap: WrapFn;
}

function shimState(): ShimState | undefined {
  return G[KEY];
}

/** (req, res, ...) or (err, req, res, next): an Express middleware or handler call. Exported for tests. */
export function isReqResCall(args: ArrayLike<unknown>): boolean {
  if (args.length < 2) return false;
  if (args[0] instanceof http.IncomingMessage) return args[1] instanceof http.ServerResponse;
  return args[1] instanceof http.IncomingMessage && args[2] instanceof http.ServerResponse;
}

/**
 * The shim's wrap: a forwarder with the function's name, length, prototype, own properties and
 * source text, marked `__hoplens` like core's wrap so nothing wraps it twice. The middleware guard
 * applies to the transform's wraps only (they carry a line); `traced()` / `step()` pass line 0 and
 * always get their hop, so traced() stays the way to trace a `(req, res)` helper.
 *
 * Re-entrant calls (recursion through the module's own binding, which the trailer points at the
 * forwarder) go straight to the function: one hop for the outermost call, and each further level costs
 * one frame, not the half dozen of a span, so recursion keeps nearly the depth it has without Hoplens.
 * Only a synchronous nested call can see `active > 0`: the outer call's own sync part is still running.
 */
function shimWrap(fn: any, meta: WrapMeta): any {
  if (typeof fn !== "function" || fn.__hoplens) return fn;
  const guard = Number(meta?.line) > 0;
  let inner: any;
  let active = 0;
  const forward = function hoplensShim(this: unknown) {
    // `arguments`, not rest args: no array copy per call.
    // biome-ignore lint/style/noArguments: see above
    const args = arguments as unknown as unknown[];
    let traced = active === 0 && !(guard && isReqResCall(args));
    if (traced && inner === undefined) {
      const real = shimState()?.real;
      if (!real) traced = false;
      else {
        try {
          const w = real(fn, meta);
          inner = typeof w === "function" ? w : fn;
        } catch {
          inner = fn;
        }
      }
    }
    if (!traced) {
      // The function itself, called the way the forwarder was. A plain call (this undefined, a few
      // args) calls it directly: no Function.prototype.apply frame, so a recursion level costs two
      // frames instead of three.
      if (new.target) return Reflect.construct(fn, args, new.target);
      if (this === undefined) {
        switch (args.length) {
          case 0:
            return fn();
          case 1:
            return fn(args[0]);
          case 2:
            return fn(args[0], args[1]);
          case 3:
            return fn(args[0], args[1], args[2]);
        }
      }
      return fn.apply(this, args);
    }
    active++;
    try {
      return new.target ? Reflect.construct(inner, args, new.target) : inner.apply(this, args);
    } finally {
      active--;
    }
  };
  try {
    Object.defineProperty(forward, "name", { value: fn.name, configurable: true });
    Object.defineProperty(forward, "length", { value: fn.length, configurable: true });
    Object.assign(forward, fn);
    (forward as any).prototype = fn.prototype;
    Object.defineProperty(forward, "toString", {
      value: () => Function.prototype.toString.call(fn),
      configurable: true,
      writable: true,
    });
    (forward as any).__hoplens = true;
  } catch {
    /* cosmetic */
  }
  return forward;
}

/**
 * Set `globalThis.__hoplens` to the shim, before user code runs. Only when nothing set it yet
 * (a running Runtime, another copy of the adapter). True when this call installed it.
 */
export function installShim(): boolean {
  if (G.__hoplens !== undefined || shimState()) return false;
  const st: ShimState = { wrap: shimWrap };
  G[KEY] = st;
  G.__hoplens = { shim: true, wrap: shimWrap, version: 0 };
  return true;
}

/**
 * Right after Runtime.start() replaced `globalThis.__hoplens`: forwarders made before boot bind to
 * its wrap, and its wrap is replaced by the shim's (emitDb and version kept), so modules loaded after
 * boot get the same middleware guard. Once per process; false when there is nothing to bind.
 */
export function bindFnShim(): boolean {
  const st = shimState();
  const h = G.__hoplens;
  if (!st || st.real || !h || h.shim || typeof h.wrap !== "function" || h.wrap === st.wrap) return false;
  st.real = h.wrap;
  h.wrap = st.wrap;
  return true;
}

export interface AutoTraceSetting {
  on: boolean;
  include?: string[];
  exclude?: string[];
  /** What decided it, for messages. */
  source: "default" | "HOPLENS_OPTIONS" | "HOPLENS_AUTOTRACE";
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined;

/**
 * autoTrace as the environment sets it, read before any module loads: `HOPLENS_AUTOTRACE=0` (or
 * `false`), else `HOPLENS_OPTIONS.autoTrace` (`false`, or `{ include, exclude }` globs). On by
 * default; unparseable HOPLENS_OPTIONS leaves it on (boot reports the bad JSON).
 */
export function readAutoTrace(env: Env = process.env): AutoTraceSetting {
  const flag = env.HOPLENS_AUTOTRACE?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return { on: false, source: "HOPLENS_AUTOTRACE" };
  let o: any;
  try {
    o = env.HOPLENS_OPTIONS ? JSON.parse(env.HOPLENS_OPTIONS) : undefined;
  } catch {
    return { on: true, source: "default" };
  }
  if (!o || typeof o !== "object") return { on: true, source: "default" };
  if (o.enabled === false || o.autoTrace === false) return { on: false, source: "HOPLENS_OPTIONS" };
  if (o.autoTrace && typeof o.autoTrace === "object") {
    const include = strings(o.autoTrace.include);
    const exclude = strings(o.autoTrace.exclude);
    return {
      on: true,
      source: "HOPLENS_OPTIONS",
      ...(include?.length ? { include } : {}),
      ...(exclude?.length ? { exclude } : {}),
    };
  }
  return { on: true, source: o.autoTrace === true ? "HOPLENS_OPTIONS" : "default" };
}

/**
 * Directories searched when the app has no `src/`. Mirrors core's FALLBACK_DIRS (sourcewatch.ts),
 * copied so the register hook stays core-free; a unit test keeps the two equal.
 */
export const FALLBACK_DIRS = [
  "app",
  "pages",
  "lib",
  "server",
  "components",
  "utils",
  "services",
  "features",
  "modules",
  "db",
  "prisma",
  "drizzle",
  "routes",
  "controllers",
  "middleware",
  "models",
];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Default autoTrace scope: everything under `src/`, else under each FALLBACK_DIRS dir present. */
export function defaultInclude(root: string): string[] {
  const dirs = isDir(path.join(root, "src")) ? ["src"] : FALLBACK_DIRS.filter((d) => isDir(path.join(root, d)));
  return dirs.map((d) => `${d}/**`);
}

/**
 * Error.stackTraceLimit while function hops run. Each traced call puts about seven frames (the
 * forwarder, core's wrap, OTel's startActiveSpan / context.with, AsyncLocalStorage.run) between a
 * function and its caller; with Node's default of 10, an error thrown two hops down would show no
 * frame of the code that called it.
 */
export const DEV_STACK_TRACE_LIMIT = 40;

/** Raise Node's default stack trace limit (10) to DEV_STACK_TRACE_LIMIT; a limit the app chose stays. */
export function raiseStackTraceLimit(): boolean {
  try {
    if (Error.stackTraceLimit !== 10) return false;
    Error.stackTraceLimit = DEV_STACK_TRACE_LIMIT;
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the transform's ESM hook and CommonJS layer for the app's own modules (the `node` preset:
 * none of the Next.js excludes). Requires @hoplens/transform only now, after the gate and autoTrace passed.
 * False when there is nothing in scope or registration failed; never throws. `retainGenerated` (the
 * request path is on): keep what another loader (tsx) compiled an app module to, so coverage offsets
 * into it map back to the file.
 */
export function startFunctionHops(
  setting: AutoTraceSetting,
  root: string | undefined,
  more: { retainGenerated?: boolean } = {},
): boolean {
  if (!setting.on || !root) return false;
  try {
    const include = setting.include ?? defaultInclude(root);
    if (!include.length) return false;
    const s = adapterState();
    const stats: AutoTraceStats = (s.autoTrace ??= { files: 0, fns: 0, refused: {}, errors: 0 });
    const { register } = require("@hoplens/transform/register") as typeof import("@hoplens/transform/register");
    register({
      root,
      include,
      exclude: setting.exclude,
      preset: "node",
      framework: "express",
      retainGenerated: more.retainGenerated === true,
      onReport: (r) => {
        if (r.type === "wrapped") {
          stats.files++;
          stats.fns += r.fns;
        } else if (r.type === "refused") {
          stats.refused[r.reason] = (stats.refused[r.reason] ?? 0) + 1;
          const first = (stats.firstRefused ??= {});
          first[r.reason] ??= { file: r.file, detail: r.reason === "unmapped" ? r.detail : undefined };
        } else if (stats.errors++ === 0) {
          process.stderr.write(
            `! hoplens:express function hops: could not rewrite ${r.file} (${r.message}); it loaded unchanged\n`,
          );
        }
      },
    });
    raiseStackTraceLimit();
    return true;
  } catch {
    return false;
  }
}
