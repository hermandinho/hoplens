// Request path: where the text V8 ran comes from when it is not the file on disk (plan P5).
//
// In order of preference:
//   1. retained by Hoplens' own loaders, while the request path is on: the ESM hook posts the
//      output of a loader that compiled a module before it (tsx's, in COMPILED mode: what it returns
//      is what V8 runs), and the CommonJS layer keeps what a require hook (tsx's) hands
//      module._compile. Only output carrying an inline source map is kept (output without one cannot
//      be mapped; Node's own type stripping blanks types to spaces, so its offsets are the file's).
//      The registry lives in @hoplens/transform (src/generated.ts) on a process global, bounded
//      (LRU, size cap); this file only reads it (and its record of why a file has no text).
//   2. nothing retained and no source map: the file on disk (identity: plain JavaScript, Node's
//      type stripping).
//   3. a source map says the script is compiled but no text was retained (tsx registered after
//      Hoplens, so it ran first): opt-in Debugger.getScriptSource, during a capture only
//      (scriptsource.ts); else UNKNOWN 'no-generated-text', with the reason missingReason() can
//      tell (no retention in this process, a size cap, Node's own transform, the loader order).

import nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSource } from "./srcmap";

const KEY = Symbol.for("hoplens.generated");

/** The registry's read side (@hoplens/transform/src/generated.ts writes it). */
interface Registry {
  get(file: string): string | undefined;
  /** Why a handed-over text is not kept ('oversize' | 'evicted'); older registries lack it. */
  dropped?(file: string): string | undefined;
}

const registry = (): Registry | undefined => (globalThis as any)[KEY];

/**
 * Registry key of an absolute path. MUST stay identical to keyOf() in
 * packages/transform/src/generated.ts (both sides normalize the same way).
 */
export function generatedKey(abs: string): string {
  const n = path.normalize(abs);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/** The text a Hoplens loader retained for `abs`, if any. */
export function retainedText(abs: string): string | undefined {
  const r = registry();
  try {
    const v = r?.get(generatedKey(abs));
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Node holds a source map for `abs` that maps it onto itself: the script V8 ran is a loader's output
 * (tsx enables source maps), not the file. Needs source maps enabled; false otherwise. Node's map
 * cache matches its key exactly (the drive letter's case included), so the script's own URL, as V8
 * reported it, is tried first; `abs` (root + hop file, whose drive letter follows the cwd's) after.
 */
export function compiledByMap(abs: string, url?: string): boolean {
  try {
    const find = (nodeModule as any).findSourceMap as ((p: string) => any) | undefined;
    if (typeof find !== "function") return false;
    const m = (url ? find(url) : undefined) ?? find(abs);
    const payload = m?.payload;
    if (!payload || !Array.isArray(payload.sources)) return false;
    const want = generatedKey(abs);
    return payload.sources.some((s: unknown) => {
      if (typeof s !== "string") return false;
      const r = resolveSource(s, payload.sourceRoot, abs);
      return r !== undefined && generatedKey(r) === want;
    });
  } catch {
    return false;
  }
}

export type GeneratedVia = "hook" | "debugger";

export type ScriptText =
  /** The text V8 ran differs from the file: here it is. */
  | { code: string; via: GeneratedVia }
  /** It differs, and no text is at hand. */
  | { missing: string };

/** What buildPayload asks per script: undefined means identity (the file on disk is what V8 ran). */
export type GeneratedLookup = (url: string, abs: string, scriptId: string) => ScriptText | undefined;

/** The default lookup: retained text, else a source map saying the script is compiled, else identity. */
export function defaultLookup(extra?: ReadonlyMap<string, string>): GeneratedLookup {
  return (url, abs, scriptId) => {
    const code = retainedText(abs);
    if (code !== undefined) return { code, via: "hook" };
    const viaDebugger = extra?.get(scriptId);
    if (viaDebugger !== undefined) return { code: viaDebugger, via: "debugger" };
    if (compiledByMap(abs, url)) return { missing: missingReason(abs) };
    return undefined;
  };
}

const DEBUGGER_HINT = "HOPLENS_PATH_DEBUGGER=1 reads it from V8 instead";

/** Why no text is at hand for a compiled `abs`, as far as this process can tell. */
export function missingReason(abs: string, features: { typescript?: unknown } = process.features as any): string {
  const r = registry();
  if (!r)
    return `the text V8 ran is not at hand: Hoplens keeps a loader's output only through its own loaders, and they are off in this process (function hops off: autoTrace false or HOPLENS_AUTOTRACE=0); ${DEBUGGER_HINT}`;
  let dropped: string | undefined;
  try {
    dropped = r.dropped?.(generatedKey(abs));
  } catch {
    dropped = undefined;
  }
  if (dropped === "oversize")
    return `the text V8 ran is not at hand: the loader's output is over Hoplens' 1MB per-file cap, so it was not kept; ${DEBUGGER_HINT}`;
  if (dropped === "evicted")
    return `the text V8 ran is not at hand: Hoplens dropped the loader's output (it keeps 16M characters in all, least recently used first); ${DEBUGGER_HINT}`;
  if (features?.typescript === "transform" && /\.[cm]?tsx?$/i.test(abs))
    return `the text V8 ran is not at hand: Node's own --experimental-transform-types (or a loader registered before Hoplens) compiled this file, and Hoplens never sees Node's output; run it with plain type stripping or \`tsx --import hoplens/express/register\`, or ${DEBUGGER_HINT}`;
  return `a loader compiled this file before Hoplens saw it (register Hoplens after it: \`tsx --import hoplens/express/register\`), or it is outside function hops' include / exclude scope, so the text V8 ran is not at hand; ${DEBUGGER_HINT}`;
}

/** Absolute path of a file:// script URL (query and hash dropped). */
export function urlPath(url: string): string | undefined {
  try {
    return fileURLToPath(url.replace(/[?#].*$/, ""));
  } catch {
    return undefined;
  }
}
