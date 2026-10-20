// ESM load hook, built to dist/hooks.mjs and registered by register.ts with `module.register()`. Runs
// in Node's hooks worker. Each in-scope ES module (plain JS, or TypeScript Node strips itself) is
// rewritten by transformSource, which only appends a trailer and swaps `const` for `let  `, so every
// line and column stays where it was.
//
// RAW mode: the source is byte-identical to the file on disk, and transformSource rewrites it.
// COMPILED mode: another loader (tsx) ran before this hook and hands it the compiled output of a
// .ts/.mts file. transformCompiled maps the raw file's exported functions onto that output and only
// appends a trailer (plus same-length `const` -> `let  ` swaps), so the loader's inline source map
// stays valid. Output it cannot map with certainty, and compiled output of any other file, is
// refused: it loads untouched and the main thread is told why. Any failure loads the original source.
//
// Request path (data.retain): the text V8 will run for an in-scope module another loader compiled
// (what this hook returns, or the loader's output it left alone) is posted to the main thread when
// it carries an inline source map, so coverage offsets into it can be mapped (src/generated.ts).
//
// Transform cache (data.cacheDir, src/cache.ts): each transform call is looked up first by a hash of
// its input, so a warm restart loads no TypeScript in this worker. Retention above still posts the
// text this hook returns, rebuilt from the loader's own source on a hit.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CachedResult, type TransformCache, cached, openCache } from "./cache";
import type { GeneratedMessage, HookData, HookReport, ReportMeta } from "./register";

type Transform = typeof import("./index");

interface LoadResult {
  format?: string | null;
  source?: string | ArrayBuffer | ArrayBufferView | null;
  shortCircuit?: boolean;
}

type NextLoad = (url: string, context?: unknown) => Promise<LoadResult>;

interface Port {
  postMessage(m: unknown): void;
  on?(event: "message", fn: (m: unknown) => void): void;
  unref?(): void;
}

type Opts = Omit<HookData, "port" | "cacheDir" | "verbose" | "retain"> & { preset: "node" | "next" };

/**
 * Sources over this size load untouched (refused "large"): parsing one with TypeScript on the hooks
 * worker would hold up its import for seconds, and a file that big is generated code, not the app's own.
 */
export const MAX_SOURCE_BYTES = 1024 * 1024;

/** Files COMPILED mode handles: ES-module TypeScript (`.cts` is CommonJS; `.tsx` is not in scope). */
const COMPILED_EXT = /\.m?ts$/;

let opts: Opts | undefined;
/**
 * `opts` with the root's real path. Node hands the hook real paths (symlinks and Windows junctions
 * resolved) while the root comes from process.cwd(), which keeps the path the shell was in.
 */
let realOpts: Opts | undefined;
let port: Port | undefined;
let disabled = false;
let retain = false;
let tx: Transform | undefined;
let cache: TransformCache | undefined;
let verbose = false;
/** TypeScript was already loaded in this worker when the last file finished. */
let tsSeen = false;

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function initialize(data: HookData | undefined): void {
  if (!data || typeof data.root !== "string") return;
  opts = {
    root: data.root,
    include: data.include,
    exclude: data.exclude,
    preset: data.preset === "next" ? "next" : "node",
  };
  try {
    const real = fs.realpathSync.native(data.root);
    if (real !== data.root) realOpts = { ...opts, root: real };
  } catch {
    /* the root as given */
  }
  port = data.port as Port | undefined;
  retain = data.retain === true;
  verbose = data.verbose === true;
  cache = openCache(typeof data.cacheDir === "string" ? data.cacheDir : undefined, HERE, data.root);
  try {
    port?.on?.("message", (m) => {
      const msg = m as { type?: unknown; id?: unknown } | null;
      if (msg?.type === "disable") disabled = true;
      // Every report this worker posted is ahead of the answer on the same port (in order).
      else if (msg?.type === "flush") port?.postMessage({ type: "flushed", id: msg.id });
    });
    port?.unref?.();
  } catch {
    /* reports are best effort */
  }
}

function report(r: HookReport | GeneratedMessage): void {
  try {
    port?.postMessage(r);
  } catch {
    /* the main thread is gone */
  }
}

/**
 * The file's timing and cache outcome, and whether it made this worker load TypeScript: only with
 * `verbose` (reports stay as they were without it).
 */
function meta(mode: ReportMeta["mode"], t0: number, hit: boolean | undefined): ReportMeta {
  if (!verbose) return {};
  const m: ReportMeta = { mode, ms: performance.now() - t0 };
  if (hit !== undefined) m.cache = hit ? "hit" : "miss";
  if (!tsSeen && tx?.typescriptLoaded()) {
    tsSeen = true;
    m.ts = "hooks";
  }
  return m;
}

/** A transform call through the cache. */
function viaCache(
  mode: NonNullable<ReportMeta["mode"]>,
  file: string,
  src: string,
  o: Opts,
  compute: () => CachedResult,
  raw?: string,
) {
  // A none is kept only when TypeScript loaded: one that failed to load must not outlive this start.
  return cached(cache, mode, file, src, o, compute, raw, () => Boolean(tx?.typescriptLoaded()));
}

/** The pure transform (dist/index.js). It loads TypeScript itself, only when a file gets parsed. */
function transform(): Transform {
  tx ??= createRequire(import.meta.url)("./index.js") as Transform;
  return tx;
}

function bytesOf(source: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof source === "string") return Buffer.from(source, "utf8");
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  return Buffer.from(source);
}

export async function load(url: string, context: unknown, nextLoad: NextLoad): Promise<LoadResult> {
  const r = await nextLoad(url, context);
  if (disabled || !opts || !url.startsWith("file:")) return r;
  let file = "";
  try {
    file = fileURLToPath(url);
    const o = optsFor(file);
    const out = rewrite(file, r, o);
    if (retain) retainCompiled(file, r, out, o);
    return out === undefined ? r : { ...r, source: out };
  } catch (err) {
    report({ type: "error", file: relOf(file), message: err instanceof Error ? err.message : String(err) });
    return r;
  }
}

const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** The options whose root contains `file`: the root as given, else its real path. */
function optsFor(file: string): Opts {
  if (realOpts && !inside(opts!.root, file) && inside(realOpts.root, file)) return realOpts;
  return opts!;
}

function relOf(file: string): string {
  return opts && file ? path.relative(optsFor(file).root, file).split(path.sep).join("/") : file;
}

/** Inline source map marker (same test as src/generated.ts retainable()). */
const INLINE_MAP = /\/\/[#@][ \t]+sourceMappingURL=data:/;

/**
 * Post the text V8 will run for an in-scope module when another loader compiled it (its source here
 * is not the file's bytes) and it carries an inline source map. Never throws.
 */
function retainCompiled(file: string, r: LoadResult, out: string | undefined, o: Opts): void {
  try {
    if (r.source == null || !/^(module|commonjs)(-typescript)?$/.test(String(r.format))) return;
    // Any extension in scope: a .tsx route's output is mapped like a .ts one's (it has no hop targets).
    if (!transform().inScope(file, o)) return;
    const bytes = bytesOf(r.source);
    if (bytes.length > MAX_SOURCE_BYTES) return;
    const code = out ?? (typeof r.source === "string" ? r.source : bytes.toString("utf8"));
    if (!INLINE_MAP.test(code)) return;
    let disk: Buffer | undefined;
    try {
      disk = fs.readFileSync(file);
    } catch {
      /* not on disk as such: nothing to map onto */
      return;
    }
    if (disk.equals(bytes)) return; // the file itself (plus Hoplens' own trailer): identity
    report({ type: "generated", file, code });
  } catch {
    /* the request path only loses this file's mapping */
  }
}

/** The rewritten source, or undefined to load `r` as it is. */
function rewrite(file: string, r: LoadResult, o: NonNullable<typeof opts>): string | undefined {
  const t = transform();
  const t0 = performance.now();
  if (r.format === "commonjs" || r.format === "commonjs-typescript") {
    // No source: Node hands the file to the CommonJS loader, where register()'s CommonJS layer sees it
    // (and reports it). With a source, Node compiles it here, out of that layer's reach: the bytes on
    // disk (Node read it itself, as it does for CommonJS TypeScript it strips: a .cts, or a .ts in a
    // CommonJS package) get the CommonJS trailer, appended at EOF; another loader's output is refused.
    if (r.source == null || !t.shouldTrace(file, "", o)) return undefined;
    const cbytes = bytesOf(r.source);
    if (cbytes.length > MAX_SOURCE_BYTES) {
      report({ type: "refused", file: relOf(file), reason: "large", ...meta("cjs", t0, undefined) });
      return undefined;
    }
    let cdisk: Buffer | undefined;
    try {
      cdisk = fs.readFileSync(file);
    } catch {
      /* not on disk as such */
    }
    if (!cdisk?.equals(cbytes)) {
      report({ type: "refused", file: relOf(file), reason: "commonjs", ...meta("cjs", t0, undefined) });
      return undefined;
    }
    const csrc = cbytes.toString("utf8");
    if (!t.shouldTrace(file, csrc, o)) return undefined;
    const { result: c, hit } = viaCache("cjs", file, csrc, o, () => {
      const x = t.transformCommonJS(csrc, file, o);
      return x ? { kind: "wrapped", code: x.code, fns: x.fns } : { kind: "none" };
    });
    if (c.kind !== "wrapped") {
      if (verbose) report({ type: "none", file: relOf(file), ...meta("cjs", t0, hit) });
      return undefined;
    }
    report({ type: "wrapped", file: relOf(file), fns: c.fns, ...meta("cjs", t0, hit) });
    return c.code;
  }
  if ((r.format !== "module" && r.format !== "module-typescript") || r.source == null) return undefined;
  const bytes = bytesOf(r.source);
  if (bytes.length > MAX_SOURCE_BYTES) {
    if (t.shouldTrace(file, "", o)) {
      report({ type: "refused", file: relOf(file), reason: "large", ...meta("raw", t0, undefined) });
    }
    return undefined;
  }
  const src = typeof r.source === "string" ? r.source : bytes.toString("utf8");
  if (!t.shouldTrace(file, src, o) || !t.mayHaveTargets(src)) return undefined;
  // Pristine check: only the bytes on disk are safe to rewrite in place.
  let disk: Buffer;
  try {
    disk = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  if (!disk.equals(bytes)) {
    if (!COMPILED_EXT.test(file)) {
      report({ type: "refused", file: relOf(file), reason: "compiled", ...meta("compiled", t0, undefined) });
      return undefined;
    }
    // COMPILED mode. The raw file decides what is in scope ('use client' and the like) and what to wrap.
    const raw = disk.toString("utf8");
    if (!t.shouldTrace(file, raw, o)) return undefined;
    const { result: c, hit } = viaCache(
      "compiled",
      file,
      src,
      o,
      () => {
        const x = t.transformCompiled(src, raw, file, o);
        return x.kind === "wrapped"
          ? x
          : x.kind === "refused"
            ? { kind: "refused", reason: x.reason }
            : { kind: "none" };
      },
      raw,
    );
    if (c.kind === "none") {
      if (verbose) report({ type: "none", file: relOf(file), ...meta("compiled", t0, hit) });
      return undefined;
    }
    if (c.kind === "refused") {
      report({
        type: "refused",
        file: relOf(file),
        reason: "unmapped",
        detail: c.reason,
        ...meta("compiled", t0, hit),
      });
      return undefined;
    }
    report({ type: "wrapped", file: relOf(file), fns: c.fns, ...meta("compiled", t0, hit) });
    return c.code;
  }
  const { result: out, hit } = viaCache("raw", file, src, o, () => {
    const code = t.transformSource(src, file, o);
    if (code == null) return { kind: "none" };
    return { kind: "wrapped", code, fns: code.slice(src.length).match(/ = __tpw\(/g)?.length ?? 0 };
  });
  if (out.kind !== "wrapped") {
    if (verbose) report({ type: "none", file: relOf(file), ...meta("raw", t0, hit) });
    return undefined;
  }
  report({ type: "wrapped", file: relOf(file), fns: out.fns, ...meta("raw", t0, hit) });
  return out.code;
}
