// Request path for Next dev (plan P6): the sticky switch, block coverage, the bundled-script view and
// the control-flow analyzer, set up by node.ts when the instrumentation hook loads Hoplens.
//
// When coverage starts: node.ts runs inside instrumentation's register(), which Next 16 calls on the
// first request (lesson 1), before the proxy and before any route bundle is required or compiled
// in that request (probed under Turbopack and --webpack). V8 gives block counts to every function
// first called after Profiler.startPreciseCoverage, including functions of modules loaded earlier
// but not yet called, so route, proxy and lib code all have them; only register() itself (running
// while coverage starts) and Next's own already-called internals keep function counts ('no-blocks').
// No preload is needed.
//
// The switch: HOPLENS_PATH (1/true on, anything else off) wins; else `<stateDir>/path.json`, the
// state dir core persists to (`<distDir>/cache/hoplens`, or withHoplens' `stateDir`), written by the
// UI's Enable button or `hoplens init --path`; else off. Read once, here. With it off nothing of the
// inspector is loaded. NODE_V8_COVERAGE (c8) leaves it disabled (core coverage.ts).

import nodePath from "node:path";
import {
  type CfgFile,
  type PathAnalyzer,
  type PathControl,
  type PathScripts,
  type ResolvedOptions,
  bundledScripts,
  flagPathControl,
  persistDir,
  startCoverage,
} from "@hoplens/core";

export interface NextPath {
  on: boolean;
  control: PathControl;
  scripts: PathScripts;
  analyzer: PathAnalyzer;
  stateDir: string;
}

/** The flag's state dir: where core persists for this app (persist.ts persistDir). */
export function pathStateDir(options: Pick<ResolvedOptions, "root" | "distDir" | "stateDir">): string {
  return persistDir(options.root, options.distDir ?? ".next", options.stateDir);
}

/**
 * Decide the request path for this process and, when on, start block coverage right away. Call it
 * before anything else of the app runs (node.ts does, first thing). Never throws.
 */
export function startNextPath(
  options: ResolvedOptions,
  env: Record<string, string | undefined> = process.env,
): NextPath {
  const stateDir = pathStateDir(options);
  const { on, control } = flagPathControl(stateDir, env);
  if (on) startCoverage(env);
  return {
    on,
    control,
    stateDir,
    scripts: bundledScripts({ root: options.root, distDir: options.distDir ?? ".next" }),
    analyzer: cfgAnalyzer(options.root),
  };
}

/**
 * A require the bundler cannot see through: node.ts runs inside Next's instrumentation bundle, and
 * Turbopack would otherwise inline (or stub) @hoplens/transform and its TypeScript. Node's own
 * createRequire, from the project root, then from @hoplens/next's or hoplens' install (pnpm does not
 * hoist @hoplens/transform into the app).
 */
function nodeRequire(root: string): (id: string) => any {
  const mod =
    (process as any).getBuiltinModule?.("node:module") ?? (globalThis as any).process?.mainModule?.constructor;
  const createRequire = mod?.createRequire as ((p: string) => NodeJS.Require) | undefined;
  if (typeof createRequire !== "function") throw new Error("node:module is not available");
  const fromRoot = createRequire(nodePath.join(root, "package.json"));
  const bases: Array<() => NodeJS.Require> = [
    () => fromRoot,
    () => createRequire(fromRoot.resolve("@hoplens/next/package.json")),
    () => createRequire(createRequire(fromRoot.resolve("hoplens/package.json")).resolve("@hoplens/next/package.json")),
  ];
  return (id: string) => {
    let last: unknown;
    for (const base of bases) {
      try {
        return base()(id);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  };
}

/** Every construct the model walks, once (the same warm-up as @hoplens/express). */
const WARM = `async function warm(a, b) {
  if (!a) return null; else if (b) throw new Error("x");
  for (const x of a) { if (x) continue; }
  switch (b) { case 1: break; default: }
  try { await a; } catch { b = a ? 1 : 2; } finally { b = a && a.f(); }
  return a ?? b;
}`;

/** The control-flow analyzer core's truth model reads: @hoplens/transform/cfg on our TypeScript. */
export function cfgAnalyzer(root: string): PathAnalyzer {
  let build: ((ts: unknown, text: string, file: string) => CfgFile | undefined) | undefined;
  let ts: unknown;
  const load = () => {
    if (!build) {
      const req = nodeRequire(root);
      build = req("@hoplens/transform/cfg").buildCfg;
      ts = req("@hoplens/transform/ts").loadTypeScript(root);
      if (typeof build !== "function") throw new Error("@hoplens/transform/cfg has no buildCfg");
    }
    return build!;
  };
  return {
    cfg(file, text) {
      return load()(ts, text, file);
    },
    warm() {
      load()(ts, WARM, "hoplens-warm.js");
    },
  };
}
