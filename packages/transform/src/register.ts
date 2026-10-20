// Node `module.register()` hook for unbundled servers (Express today). Registers the ESM load hook
// (src/hooks.ts, built to dist/hooks.mjs) and installs the CommonJS layer (src/cjs.ts: a self-healing
// Module._extensions wrapper with a scoped fs.readFileSync swap) once per process, from the main
// thread only: a `-r` preload also runs inside the hooks worker, where registering again would chain
// a second copy.
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
      const data: HookData = {
        root: opts.root,
        include: opts.include,
        exclude: opts.exclude,
        preset: opts.preset ?? "node",
        port: port2,
      };
      if (opts.retainGenerated) data.retain = true;
      if (cacheDir) data.cacheDir = cacheDir;
      if (verbose) data.verbose = true;
      (nodeModule as any).register(pathToFileURL(path.join(__dirname, "hooks.mjs")).href, {
        data,
        transferList: [port2],
      });
      disposers.push(() => port1.postMessage({ type: "disable" }));
    } catch {
      /* the CommonJS layer still works */
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
