// Node `module.register()` hook for unbundled servers (Express today). Registers the ESM load hook
// (src/hooks.ts, built to dist/hooks.mjs) and installs the CommonJS layer (src/cjs.ts: a self-healing
// Module._extensions wrapper with a scoped fs.readFileSync swap) once per process, from the main
// thread only: a `-r` preload also runs inside the hooks worker, where registering again would chain
// a second copy.

import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel, isMainThread } from "node:worker_threads";
import { installCommonJS } from "./cjs";
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
 * - `commonjs`: a CommonJS module another loader compiled for Node's ESM loader (its source never
 *   reaches the CommonJS layer);
 * - `esm-loader`: a CommonJS module Node read through its ESM loader before the CommonJS layer could
 *   swap its source: the entry of a process started with `--import`, or a CommonJS file imported from
 *   an ES module (`-r` loads a CommonJS entry through the CommonJS loader, where it is wrapped);
 * - `large`: a source over 1 MB (generated code), not parsed.
 */
export type HookReport =
  | { type: "wrapped"; file: string; fns: number }
  | { type: "refused"; file: string; reason: "compiled" | "commonjs" | "esm-loader" | "large" }
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
    const onReport = (m: HookReport) => {
      try {
        opts.onReport?.(m);
      } catch {
        /* a report never breaks the app */
      }
    };
    const disposers: (() => void)[] = [];
    try {
      disposers.push(
        installCommonJS({ root: opts.root, include: opts.include, exclude: opts.exclude, report: onReport }),
      );
    } catch {
      /* the ESM hook still goes in */
    }
    try {
      if (typeof (nodeModule as any).register !== "function") throw new Error("no module.register");
      const { port1, port2 } = new MessageChannel();
      port1.on("message", onReport);
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
