// Node module hooks for unbundled servers (Express today). Registers the ESM load step
// (src/esmload.ts) and installs the CommonJS layer (src/cjs.ts: a self-healing Module._extensions
// wrapper with a scoped fs.readFileSync swap) once per process, from the main thread only: a `-r`
// preload also runs inside the hooks worker, where registering again would chain a second copy.
//
// Which hook API: the ESM step must sit on the same side as tsx's hooks, so that the flag order
// decides which loader sees the other's output (`--import tsx --import hoplens`: ours runs first and
// gets tsx's output, COMPILED mode; the other order: RAW). Synchronous hooks (`module.registerHooks()`)
// always run before every asynchronous one (`module.register()`, in the hooks worker), whatever the
// order they were registered in. tsx (4.23.15 checked) registers synchronous hooks on Node 22.22.3+ /
// 24.11.1+ / 25.1+ (its own feature table, SYNC_HOOKS_SINCE), asynchronous ones below that, so Hoplens
// does the same (hookApi(); HOPLENS_LOADER_HOOKS=sync|async overrides). An async hook next to tsx's
// sync ones would also send a CommonJS `.ts` entry through Node's ESM translator on 24 (its
// `require.cache` is undefined there). The sync hook passes `require()` of CommonJS straight through:
// the CommonJS layer handles those reads.
//
// Transform cache (src/cache.ts, `cacheDir`): both loaders look each file up there before they parse
// it, so a warm restart loads no TypeScript. HOPLENS_DEBUG=transform (or `debug: true`) prints one
// line per in-scope file to stderr (debugLine()), never to stdout.

import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel, isMainThread } from "node:worker_threads";
import { cacheDisabledByEnv } from "./cache";
import { installCommonJS } from "./cjs";
import { type LoadResult, createEsmLoader } from "./esmload";
import { retainGenerated, retentionOn } from "./generated";
import type { TransformOptions } from "./index";

export interface RegisterOptions extends TransformOptions {
  framework?: "nest" | "express" | "fastify" | "koa" | string;
  /** Called on the main thread for each report the hook sends (wrapped, refused, failed files). */
  onReport?: (report: HookReport) => void;
  /**
   * Keep the output another loader (tsx) compiled an in-scope module to, when it carries an inline
   * source map, for the request path (src/generated.ts). Set only while the request path is on.
   */
  retainGenerated?: boolean;
  /**
   * The transform cache's directory (`<stateDir>/transform` for Express). Unset, or
   * HOPLENS_TRANSFORM_CACHE=0: no cache, every start parses every file.
   */
  cacheDir?: string;
  /**
   * Print one line per in-scope file to stderr (debugLine()), and report files with nothing to wrap
   * (`type: "none"`). Default: HOPLENS_DEBUG names `transform` (or is `1`, `*`, `all`).
   */
  debug?: boolean;
  /** Also report files with nothing to wrap (`type: "none"`), without printing. Implied by `debug`. */
  verbose?: boolean;
}

/** The hook's message carrying a compiled module's text (kept by the main thread, never reported). */
export interface GeneratedMessage {
  type: "generated";
  /** Absolute path. */
  file: string;
  code: string;
}

/**
 * What the hook reports per in-scope file. `refused` and `error` mean the file loaded untouched:
 * - `compiled`: another loader (tsx, ts-node/esm) changed a non-TypeScript source before Hoplens saw it;
 * - `unmapped`: a .ts/.mts file another loader compiled first, whose output COMPILED mode could not map
 *   back to the file on disk with certainty (`detail` says what did not match);
 * - `commonjs`: a CommonJS module another loader compiled for Node's ESM loader (its source never
 *   reaches the CommonJS layer);
 * - `esm-loader`: a CommonJS module Node read through its ESM loader before the CommonJS layer could
 *   swap its source: the entry of a process started with `--import`, or a CommonJS file imported from
 *   an ES module (`-r` loads a CommonJS entry through the CommonJS loader, where it is wrapped);
 * - `large`: a source over 1 MB (generated code), not parsed.
 */
export type HookReport = (
  | { type: "wrapped"; file: string; fns: number }
  | { type: "refused"; file: string; reason: "compiled" | "commonjs" | "esm-loader" | "large" }
  | { type: "refused"; file: string; reason: "unmapped"; detail: string }
  /** Parsed, nothing to wrap. Only reported with `verbose` / `debug`. */
  | { type: "none"; file: string }
  | { type: "error"; file: string; message: string }
) &
  ReportMeta;

/** Why a file loaded untouched (HookReport `refused`). */
export type RefusalReason = "compiled" | "unmapped" | "commonjs" | "esm-loader" | "large";

/**
 * One short phrase per refusal reason: the debug log prints `refused=<reason> (<label>)`, and the
 * banner and `hoplens doctor` use the same reason names.
 */
export const REFUSAL_LABELS: Record<RefusalReason, string> = {
  compiled: "another loader changed the source before Hoplens saw it",
  unmapped: "the compiled output does not map back to the source",
  commonjs: "CommonJS another loader compiled for Node's ESM loader",
  "esm-loader": "CommonJS Node read through its ESM loader",
  large: "over 1 MB, not parsed",
};

/** How a loader handled the file: RAW (ESM, the bytes on disk), COMPILED (tsx's output), CommonJS. */
export type LoaderMode = "raw" | "compiled" | "cjs";

/** What every report may carry besides its outcome (the debug log prints it). */
export interface ReportMeta {
  mode?: LoaderMode;
  /** The transform cache answered (`hit`), or the file was parsed and stored (`miss`). */
  cache?: "hit" | "miss";
  /** Time spent on the file in the loader (cache lookup and transform), in ms. */
  ms?: number;
  /** This file made the thread load TypeScript (the first parse in that thread). */
  ts?: "hooks" | "main";
}

/** HOPLENS_DEBUG asks for the transform's log: `transform` in its comma list, or `1` / `*` / `all`. */
export function transformDebug(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.HOPLENS_DEBUG?.trim().toLowerCase();
  if (!v) return false;
  return v.split(/[\s,]+/).some((t) => t === "transform" || t === "1" || t === "*" || t === "all" || t === "true");
}

/** The debug log's line for a report: `hoplens:transform src/a.ts mode=raw wrapped=2 cache=hit 0.3ms`. */
export function debugLine(r: HookReport): string {
  let what: string;
  if (r.type === "wrapped") what = `wrapped=${r.fns}`;
  else if (r.type === "none") what = "none";
  else if (r.type === "refused") {
    const label = REFUSAL_LABELS[r.reason] ?? r.reason;
    what = `refused=${r.reason} (${r.reason === "unmapped" && r.detail ? `${label}: ${r.detail}` : label})`;
  } else what = `error=${JSON.stringify(r.message)}`;
  const parts = [`hoplens:transform ${r.file}`];
  if (r.mode) parts.push(`mode=${r.mode}`);
  parts.push(what);
  if (r.cache) parts.push(`cache=${r.cache}`);
  if (r.ts) parts.push(`ts=loaded(${r.ts})`);
  if (typeof r.ms === "number") parts.push(`${r.ms.toFixed(1)}ms`);
  return parts.join(" ");
}

/** Answer to a `{ type: "flush", id }` the main thread sent the hook: every report before it arrived. */
export interface FlushedMessage {
  type: "flushed";
  id: number;
}

const FLUSH = Symbol.for("hoplens.transform.flush");

/**
 * Call `cb` once every report the ESM hook posted so far has reached `onReport` (the hooks worker
 * answers a flush on the same port, after them), or after `timeoutMs`. The worker's reports arrive
 * on the main thread's event loop, which can be later than the app's first `listen()` when a file
 * costs the hook no parse (a transform cache hit). Right away when no hook was registered.
 */
export function flushReports(cb: () => void, timeoutMs = 500): void {
  const f = (globalThis as any)[FLUSH];
  if (typeof f === "function") f(cb, timeoutMs);
  else cb();
}

/** Data handed to the hook's `initialize()`. */
export interface HookData {
  root: string;
  include?: string[];
  exclude?: string[];
  preset?: TransformOptions["preset"];
  /** A MessagePort: reports go out on it, `{ type: "disable" }` and `{ type: "flush", id }` come in. */
  port?: unknown;
  /** Post GeneratedMessage for compiled in-scope modules (RegisterOptions.retainGenerated). */
  retain?: boolean;
  /** RegisterOptions.cacheDir (already checked against HOPLENS_TRANSFORM_CACHE). */
  cacheDir?: string;
  /** Report files with nothing to wrap too (RegisterOptions.verbose / debug). */
  verbose?: boolean;
}

/**
 * The Node versions on which tsx uses `module.registerHooks()` (tsx 4.23.15's own feature table, the
 * first release of each line). Same table, so Hoplens' ESM step and tsx's hooks are always both
 * synchronous or both asynchronous.
 */
export const SYNC_HOOKS_SINCE: readonly (readonly [number, number, number])[] = [
  [22, 22, 3],
  [24, 11, 1],
  [25, 1, 0],
  [26, 0, 0],
];

/** `version` (`v22.23.3`) is at or past the SYNC_HOOKS_SINCE entry of its major (or a later major's). */
export function versionHasSyncHooks(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  const last = SYNC_HOOKS_SINCE[SYNC_HOOKS_SINCE.length - 1]!;
  if (v[0]! > last[0]) return true;
  const row = SYNC_HOOKS_SINCE.find((r) => r[0] === v[0]);
  if (!row) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== row[i]) return v[i]! > row[i]!;
  return true;
}

/**
 * Node evaluates `--import` modules in flag order. Node 20.9 / 20.10 do not when a module's graph has
 * CommonJS in it (tsx's does, and so does Hoplens' register hook): such a module finishes after the
 * `--import` flags behind it, so `--import tsx --import hoplens` registers tsx's hooks last and they run
 * first, and Hoplens sees each file as on disk (RAW, not COMPILED). Fixed in 20.11.0 (bisected on
 * 20.9.0 / 20.10.0 / 20.11.0 builds; 21.x not checked).
 */
export function importOrderHonored(version: string = process.version): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const major = Number(m[1]);
  if (major !== 20) return major > 20;
  return Number(m[2]) >= 11;
}

/** Which hook API register() uses for the ESM step on this process. */
export type HookApi = "sync" | "async";

/**
 * `sync` (module.registerHooks, in-thread) where tsx uses it too, else `async` (module.register, the
 * hooks worker). HOPLENS_LOADER_HOOKS=sync|async overrides (sync only where registerHooks exists).
 */
export function hookApi(
  env: Record<string, string | undefined> = process.env,
  version: string = process.version,
  hasRegisterHooks: boolean = typeof (nodeModule as any).registerHooks === "function",
): HookApi {
  const want = env.HOPLENS_LOADER_HOOKS?.trim().toLowerCase();
  if (want === "async") return "async";
  if (want === "sync") return hasRegisterHooks ? "sync" : "async";
  return hasRegisterHooks && versionHasSyncHooks(version) ? "sync" : "async";
}

/** A sync hook's load context for `require()` (not `import`): CommonJS reads belong to the CommonJS layer. */
function requireContext(context: unknown): boolean {
  const c = (context as { conditions?: unknown } | null)?.conditions;
  return Array.isArray(c) && c.includes("require") && !c.includes("import");
}

const API = Symbol.for("hoplens.transform.hookApi");

/** The hook API register() used in this process (undefined before it ran or when it registered nothing). */
export function registeredHookApi(): HookApi | undefined {
  return (globalThis as any)[API];
}

const REGISTERED = Symbol.for("hoplens.transform.register");

/**
 * Register the ESM load hook and install the CommonJS layer. Never throws. Returns a disposer that
 * turns the hook into a pass-through (Node cannot unregister a hook) and takes the CommonJS layer out.
 * A second call in the same process, or a call off the main thread, registers nothing.
 */
export function register(opts: RegisterOptions = { root: process.cwd() }): () => void {
  const noop = () => {};
  try {
    if (!isMainThread) return noop;
    const g = globalThis as any;
    if (g[REGISTERED]) return noop;
    g[REGISTERED] = true;
    const debug = opts.debug ?? transformDebug();
    const verbose = debug || opts.verbose === true;
    const cacheDir = opts.cacheDir && !cacheDisabledByEnv() ? opts.cacheDir : undefined;
    const onReport = (m: HookReport) => {
      if (debug) {
        try {
          process.stderr.write(`${debugLine(m)}\n`);
        } catch {
          /* a closed stderr never breaks the app */
        }
      }
      try {
        opts.onReport?.(m);
      } catch {
        /* a report never breaks the app */
      }
    };
    const disposers: (() => void)[] = [];
    if (opts.retainGenerated) retentionOn();
    try {
      disposers.push(
        installCommonJS({
          root: opts.root,
          include: opts.include,
          exclude: opts.exclude,
          report: onReport,
          retainGenerated: opts.retainGenerated,
          cacheDir,
          verbose,
        }),
      );
    } catch {
      /* the ESM hook still goes in */
    }
    const data: HookData = {
      root: opts.root,
      include: opts.include,
      exclude: opts.exclude,
      preset: opts.preset ?? "node",
    };
    if (opts.retainGenerated) data.retain = true;
    if (cacheDir) data.cacheDir = cacheDir;
    if (verbose) data.verbose = true;
    const api = hookApi();
    if (api === "sync") {
      try {
        let tx: typeof import("./index") | undefined;
        const loader = createEsmLoader(data, {
          post: (m) => {
            if (m.type === "generated") retainGenerated(m.file, m.code);
            else onReport(m);
          },
          // A computed path (as in cjs.ts), so the bundler leaves dist/index.js out of register.js.
          transform: () => {
            tx ??= require(path.join(__dirname, "index.js")) as typeof import("./index");
            return tx;
          },
          typescriptLoaded: () => Boolean(tx?.typescriptLoaded()),
          distDir: __dirname,
          thread: "main",
        });
        const handle = (nodeModule as any).registerHooks({
          load(url: string, context: unknown, nextLoad: (u: string, c?: unknown) => LoadResult): LoadResult {
            const r = nextLoad(url, context);
            const cjs = /^commonjs/.test(String(r?.format));
            // `require()` of CommonJS: the CommonJS layer sees that read.
            if (cjs && requireContext(context)) return r;
            // Imported CommonJS Node reloads through its CommonJS loader: with the pristine source the
            // step wraps it (the reload compiles what it returns); another loader's output (tsx) is not
            // refused, the CommonJS layer may see the file there.
            const reloaded =
              cjs && (r as { shouldBeReloadedByCJSLoader?: unknown }).shouldBeReloadedByCJSLoader === true;
            return loader.load(url, r, reloaded);
          },
        });
        g[API] = "sync";
        disposers.push(() => {
          loader.disable();
          handle?.deregister?.();
        });
      } catch {
        /* the CommonJS layer still works */
      }
    } else {
      try {
        if (typeof (nodeModule as any).register !== "function") throw new Error("no module.register");
        const { port1, port2 } = new MessageChannel();
        const waiting = new Map<number, () => void>();
        let seq = 0;
        port1.on("message", (m: HookReport | GeneratedMessage | FlushedMessage) => {
          if (m?.type === "generated") retainGenerated(m.file, m.code);
          else if (m?.type === "flushed") waiting.get(m.id)?.();
          else onReport(m);
        });
        g[FLUSH] = (cb: () => void, timeoutMs: number) => {
          const id = ++seq;
          let done = false;
          const fire = () => {
            if (done) return;
            done = true;
            waiting.delete(id);
            clearTimeout(timer);
            try {
              cb();
            } catch {
              /* the caller's own */
            }
          };
          // Kept ref'd: it holds the process open until the answer (the port itself is unref'd).
          const timer = setTimeout(fire, timeoutMs);
          waiting.set(id, fire);
          try {
            port1.postMessage({ type: "flush", id });
          } catch {
            fire();
          }
        };
        port1.unref();
        data.port = port2;
        (nodeModule as any).register(pathToFileURL(path.join(__dirname, "hooks.mjs")).href, {
          data,
          transferList: [port2],
        });
        g[API] = "async";
        disposers.push(() => port1.postMessage({ type: "disable" }));
      } catch {
        /* the CommonJS layer still works */
      }
    }
    return () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* already closed */
        }
      }
    };
  } catch {
    return noop;
  }
}
