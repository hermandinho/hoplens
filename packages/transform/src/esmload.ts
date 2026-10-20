// The ESM load step of register(), shared by its two homes:
//
// - the async hook (src/hooks.ts, built to dist/hooks.mjs, `module.register()`), run in Node's hooks
//   worker; reports and retained text go to the main thread over a MessagePort;
// - the in-thread hook (`module.registerHooks()`, register.ts), on the Nodes where tsx registers its
//   own hooks that way (hookApi()): synchronous hooks always run before every async one, so
//   an async hook of ours would sit inside tsx's whatever the flag order, and never see its output.
//   On the main thread, reports and retained text go straight to the main thread's sinks.
//
// Each in-scope ES module (plain JS, or TypeScript Node strips itself) is rewritten by transformSource,
// which only appends a trailer and swaps `const` for `let  `, so every line and column stays where it was.
//
// RAW mode: the source is byte-identical to the file on disk, and transformSource rewrites it.
// COMPILED mode: another loader (tsx) ran before this hook and hands it the compiled output of a
// .ts/.mts file. transformCompiled maps the raw file's exported functions onto that output and only
// appends a trailer (plus same-length `const` -> `let  ` swaps), so the loader's inline source map
// stays valid. Output it cannot map with certainty, and compiled output of any other file, is
// refused: it loads untouched and the main thread is told why. Any failure loads the original source.
//
// Request path (retain): the text V8 will run for an in-scope module another loader compiled (what
// this step returns, or the loader's output it left alone) is handed on when it carries an inline
// source map, so coverage offsets into it can be mapped (src/generated.ts).
//
// Transform cache (cacheDir, src/cache.ts): each transform call is looked up first by a hash of its
// input, so a warm restart loads no TypeScript in this thread. Retention above still hands on the
// text this step returns, rebuilt from the loader's own source on a hit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CachedResult, type TransformCache, cached, openCache } from "./cache";
import type { GeneratedMessage, HookData, HookReport, ReportMeta } from "./register";

type Transform = typeof import("./index");

export interface LoadResult {
  format?: string | null;
  source?: string | ArrayBuffer | ArrayBufferView | null;
  shortCircuit?: boolean;
}

type Opts = Omit<HookData, "port" | "cacheDir" | "verbose" | "retain"> & { preset: "node" | "next" };

/**
 * Sources over this size load untouched (refused "large"): parsing one with TypeScript would hold up
 * its import for seconds, and a file that big is generated code, not the app's own.
 */
export const MAX_SOURCE_BYTES = 1024 * 1024;

/** Files COMPILED mode handles: ES-module TypeScript (`.cts` is CommonJS; `.tsx` is not in scope). */
const COMPILED_EXT = /\.m?ts$/;

/** Inline source map marker (same test as src/generated.ts retainable()). */
const INLINE_MAP = /\/\/[#@][ \t]+sourceMappingURL=data:/;

/**
 * Set once a report of this thread carried `ts`: the CommonJS layer (src/cjs.ts) reads the same flag,
 * so with the in-thread hook the first file to load TypeScript on the main thread says so once.
 */
const TS_SEEN = Symbol.for("hoplens.transform.tsSeen");

/** Claim "this file made the thread load TypeScript" (true once per thread). */
export function claimTsLoaded(loaded: boolean): boolean {
  const g = globalThis as any;
  if (!loaded || g[TS_SEEN]) return false;
  g[TS_SEEN] = true;
  return true;
}

const HANDLED = Symbol.for("hoplens.transform.esmHandledCommonJS");
const handledKey = (file: string) =>
  process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);

/**
 * A CommonJS file whose source the in-thread ESM step got from Node (an `import` of it) and reported:
 * the CommonJS layer, which then never sees a read of it, does not report it again as `esm-loader`.
 */
export function esmHandledCommonJS(file: string): boolean {
  const s = (globalThis as any)[HANDLED] as Set<string> | undefined;
  return !!s && s.has(handledKey(file));
}

function markHandledCommonJS(file: string): void {
  const g = globalThis as any;
  const s: Set<string> = (g[HANDLED] ??= new Set<string>());
  // Bounded: a long-lived process importing many CommonJS files keeps only the latest few thousand.
  if (s.size > 10000) s.clear();
  s.add(handledKey(file));
}

export interface EsmLoaderDeps {
  /** Where reports and retained text go (the port, or the main thread's own sinks). */
  post(m: HookReport | GeneratedMessage): void;
  /** The pure transform (dist/index.js), required on the first file this step parses. */
  transform(): Transform;
  /** True when the transform module is loaded and has loaded TypeScript (no require of it). */
  typescriptLoaded(): boolean;
  /** dist/, for the cache's transform version. */
  distDir: string;
  /** What `ts` says when this thread loaded TypeScript: the hooks worker, or the main thread. */
  thread: "hooks" | "main";
}

export interface EsmLoader {
  /**
   * `r` with the rewritten source, or `r` itself. Never throws. `reloaded`: Node (or the loader before
   * this step) hands a CommonJS result to the CommonJS loader afterwards (`shouldBeReloadedByCJSLoader`),
   * where the CommonJS layer may see the file: another loader's output there is not refused.
   */
  load(url: string, r: LoadResult, reloaded?: boolean): LoadResult;
  disable(): void;
}

function bytesOf(source: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof source === "string") return Buffer.from(source, "utf8");
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  return Buffer.from(source);
}

/**
 * The root's real paths other than the root itself: the JS `fs.realpathSync` (what Node's loaders
 * use, so 8.3 short names stay) and the native one (short names expanded), deduplicated.
 */
export function realRoots(root: string): string[] {
  const out: string[] = [];
  for (const real of [fs.realpathSync, fs.realpathSync.native]) {
    try {
      const r = real(root);
      if (r !== root && !out.includes(r)) out.push(r);
    } catch {
      /* the root as given */
    }
  }
  return out;
}

const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** The load step for `data` (undefined when `data` has no root: every load passes through). */
export function createEsmLoader(data: HookData | undefined, deps: EsmLoaderDeps): EsmLoader {
  let disabled = false;
  const pass: EsmLoader = { load: (_u, r) => r, disable() {} };
  if (!data || typeof data.root !== "string") return pass;
  const opts: Opts = {
    root: data.root,
    include: data.include,
    exclude: data.exclude,
    preset: data.preset === "next" ? "next" : "node",
  };
  /**
   * `opts` with each real path of the root. Node hands the hook real paths (symlinks and Windows
   * junctions resolved) while the root comes from process.cwd(), which keeps the path the shell was in.
   * Node's resolver uses the JS `fs.realpathSync`, which keeps Windows 8.3 short names
   * (`C:\Users\RUNNER~1`); the native one expands them, so both are kept.
   */
  const realOpts: Opts[] = realRoots(data.root).map((root) => ({ ...opts, root }));
  const retain = data.retain === true;
  const verbose = data.verbose === true;
  const cache: TransformCache | undefined = openCache(
    typeof data.cacheDir === "string" ? data.cacheDir : undefined,
    deps.distDir,
    data.root,
  );

  const report = (r: HookReport | GeneratedMessage) => {
    try {
      deps.post(r);
    } catch {
      /* the main thread is gone */
    }
  };

  /** The options whose root contains `file`: the root as given, else its real path. */
  const optsFor = (file: string): Opts =>
    (!inside(opts.root, file) && realOpts.find((o) => inside(o.root, file))) || opts;
  const relOf = (file: string) => (file ? path.relative(optsFor(file).root, file).split(path.sep).join("/") : file);

  /**
   * The file's timing and cache outcome, and whether it made this thread load TypeScript: only with
   * `verbose` (reports stay as they were without it).
   */
  const meta = (mode: ReportMeta["mode"], t0: number, hit: boolean | undefined): ReportMeta => {
    if (!verbose) return {};
    const m: ReportMeta = { mode, ms: performance.now() - t0 };
    if (hit !== undefined) m.cache = hit ? "hit" : "miss";
    if (claimTsLoaded(deps.typescriptLoaded())) m.ts = deps.thread;
    return m;
  };

  /** A transform call through the cache. */
  const viaCache = (
    mode: NonNullable<ReportMeta["mode"]>,
    file: string,
    src: string,
    o: Opts,
    compute: () => CachedResult,
    raw?: string,
  ) =>
    // A none is kept only when TypeScript loaded: one that failed to load must not outlive this start.
    cached(cache, mode, file, src, o, compute, raw, () => deps.typescriptLoaded());

  /**
   * Hand on the text V8 will run for an in-scope module when another loader compiled it (its source
   * here is not the file's bytes) and it carries an inline source map. Never throws.
   */
  function retainCompiled(file: string, r: LoadResult, out: string | undefined, o: Opts): void {
    try {
      if (r.source == null || !/^(module|commonjs)(-typescript)?$/.test(String(r.format))) return;
      // Any extension in scope: a .tsx route's output is mapped like a .ts one's (it has no hop targets).
      if (!deps.transform().inScope(file, o)) return;
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
  function rewrite(file: string, r: LoadResult, o: Opts, reloaded: boolean): string | undefined {
    const t = deps.transform();
    const t0 = performance.now();
    if (r.format === "commonjs" || r.format === "commonjs-typescript") {
      // No source: Node hands the file to the CommonJS loader, where register()'s CommonJS layer sees it
      // (and reports it). With a source, Node compiles it here, out of that layer's reach: the bytes on
      // disk (Node read it itself, as it does for CommonJS TypeScript it strips: a .cts, or a .ts in a
      // CommonJS package) get the CommonJS trailer, appended at EOF; another loader's output is refused.
      if (r.source == null || !t.shouldTrace(file, "", o)) return undefined;
      const cbytes = bytesOf(r.source);
      const mark = () => deps.thread === "main" && markHandledCommonJS(file);
      if (cbytes.length > MAX_SOURCE_BYTES) {
        mark();
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
        // Reloaded: the CommonJS layer reports it (wrapped when it sees the read, else esm-loader).
        if (reloaded) return undefined;
        mark();
        report({ type: "refused", file: relOf(file), reason: "commonjs", ...meta("cjs", t0, undefined) });
        return undefined;
      }
      // From here on this step reports the file (or found nothing to wrap): the CommonJS layer, which
      // sees no read of it, stays quiet.
      mark();
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

  return {
    disable() {
      disabled = true;
    },
    load(url, r, reloaded = false) {
      if (disabled || !url.startsWith("file:")) return r;
      let file = "";
      try {
        file = fileURLToPath(url);
        const o = optsFor(file);
        const out = rewrite(file, r, o, reloaded);
        if (retain) retainCompiled(file, r, out, o);
        return out === undefined ? r : { ...r, source: out };
      } catch (err) {
        report({ type: "error", file: relOf(file), message: err instanceof Error ? err.message : String(err) });
        return r;
      }
    },
  };
}
