// Node `module.register()` hook for unbundled servers (Express today). Registers the ESM load hook
// (src/hooks.ts, built to dist/hooks.mjs) once per process, from the main thread only: a `-r`
// preload also runs inside the hooks worker, where registering again would chain a second copy.
//
// CommonJS (`require`) is not handled yet: those files load untouched.

import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel, isMainThread } from "node:worker_threads";
import type { TransformOptions } from "./index";

export interface RegisterOptions extends TransformOptions {
  framework?: "nest" | "express" | "fastify" | "koa" | string;
  /** Called on the main thread for each report the hook sends (wrapped, refused, failed files). */
  onReport?: (report: HookReport) => void;
}

/**
 * What the hook reports per in-scope file. `refused` and `error` mean the file loaded untouched:
 * - `compiled`: another loader (tsx, ts-node/esm) changed a non-TypeScript source before Hoplens saw it;
 * - `unmapped`: a .ts/.mts file another loader compiled first, whose output COMPILED mode could not map
 *   back to the file on disk with certainty (`detail` says what did not match);
 * - `commonjs`: a CommonJS module reached through the ESM loader, not wrapped yet;
 * - `large`: a source over 1 MB (generated code), not parsed.
 */
export type HookReport =
  | { type: "wrapped"; file: string; fns: number }
  | { type: "refused"; file: string; reason: "compiled" | "commonjs" | "large" }
  | { type: "refused"; file: string; reason: "unmapped"; detail: string }
  | { type: "error"; file: string; message: string };

/** Data handed to the hook's `initialize()`. */
export interface HookData {
  root: string;
  include?: string[];
  exclude?: string[];
  preset?: TransformOptions["preset"];
  /** A MessagePort: reports go out on it, `{ type: "disable" }` comes in. */
  port?: unknown;
}

const REGISTERED = Symbol.for("hoplens.transform.register");

/**
 * Register the ESM load hook. Never throws. Returns a disposer that turns the hook into a pass-through
 * (Node cannot unregister a hook). A second call in the same process, or a call off the main thread,
 * registers nothing.
 */
export function register(opts: RegisterOptions = { root: process.cwd() }): () => void {
  const noop = () => {};
  try {
    if (!isMainThread) return noop;
    const g = globalThis as any;
    if (g[REGISTERED]) return noop;
    if (typeof (nodeModule as any).register !== "function") return noop;
    g[REGISTERED] = true;
    const { port1, port2 } = new MessageChannel();
    port1.on("message", (m: HookReport) => {
      try {
        opts.onReport?.(m);
      } catch {
        /* a report never breaks the app */
      }
    });
    port1.unref();
    const data: HookData = {
      root: opts.root,
      include: opts.include,
      exclude: opts.exclude,
      preset: opts.preset ?? "node",
      port: port2,
    };
    (nodeModule as any).register(pathToFileURL(path.join(__dirname, "hooks.mjs")).href, {
      data,
      transferList: [port2],
    });
    return () => {
      try {
        port1.postMessage({ type: "disable" });
      } catch {
        /* already closed */
      }
    };
  } catch {
    return noop;
  }
}
