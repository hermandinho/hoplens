// Request path: the control-flow analyzer core's truth model reads (RuntimeConfig.path.analyzer).
// Core has no TypeScript, so the model is built here with @hoplens/transform/cfg and our own
// TypeScript (loadTypeScript, ours first). Both load on the first analysis, or on warm().

import type { CfgFile, PathAnalyzer } from "@hoplens/core";
import type * as Cfg from "@hoplens/transform/cfg";

/**
 * Compile-time check that transform's model is core's contract (core keeps a copy of the types:
 * packages/core/src/path/cfg-model.ts). A field added to one but not the other fails here.
 */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameModel: Same<Cfg.CfgFile, CfgFile> = true;
void sameModel;

/** Every construct the model walks, once. */
const WARM = `async function warm(a, b) {
  if (!a) return null; else if (b) throw new Error("x");
  for (const x of a) { if (x) continue; }
  switch (b) { case 1: break; default: }
  try { await a; } catch { b = a ? 1 : 2; } finally { b = a && a.f(); }
  return a ?? b;
}`;

export function cfgAnalyzer(root: string): PathAnalyzer {
  let build: ((ts: unknown, text: string, file: string) => CfgFile | undefined) | undefined;
  let ts: unknown;
  const load = () => {
    if (!build) {
      const mod = require("@hoplens/transform/cfg") as typeof Cfg;
      build = mod.buildCfg;
      const { loadTypeScript } = require("@hoplens/transform/ts") as typeof import("@hoplens/transform/ts");
      ts = loadTypeScript(root);
    }
    return build;
  };
  return {
    cfg(file, text) {
      return load()(ts, text, file);
    },
    warm() {
      // One small parse too: the first createSourceFile and model build pay for JIT (~20ms).
      load()(ts, WARM, "hoplens-warm.js");
    },
  };
}
