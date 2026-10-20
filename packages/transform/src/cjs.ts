// CommonJS layer of register(): function hops for modules loaded with `require`.
//
// A wrapper goes on Module._extensions for .js / .cjs / .ts / .cts (only the handlers that exist), on
// top of whatever is there (Node's own, tsx's, ts-node's), and it puts itself back on top on every
// Module._load when another loader replaced a handler later ("self-healing"). While the handler below
// runs for an in-scope file, fs.readFileSync answers for exactly that resolved filename with the source
// from disk plus transformCommonJS's trailer; every other read passes straight through, and the
// original fs.readFileSync is back as soon as the handler calls module._compile (an own property of
// that one module object, removed before compile runs), or returns or throws (finally). The handler compiles what
// it read as it always does, so the next loader (tsx's esbuild, ts-node) sees source whose lines and
// columns are the file's own, and its source map and every stack line:col stay what they were.
//
// The transform runs only when the handler reads the file: a module whose source Node already holds
// (a CommonJS file reached through Node's ESM loader: the entry of a process started with --import, or
// a file imported from ESM) is never parsed, and is reported as `esm-loader`. Module.prototype._compile
// is never touched.
//
// Request path (retainGenerated): when the handler hands module._compile something other than what it
// read (a require hook compiled it: tsx's esbuild), that text is what V8 runs and its coverage offsets
// point into; it is kept for the request path when it carries an inline source map (src/generated.ts).
//
// Transform cache (opts.cacheDir, src/cache.ts): transformCommonJS is looked up by a hash of the source
// first, so a warm restart loads no TypeScript in the main thread. What is retained is still what the
// handler hands module._compile, whatever answered the read.

import fs from "node:fs";
import nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cached, openCache } from "./cache";
import { claimTsLoaded, esmHandledCommonJS } from "./esmload";
import { retainGenerated } from "./generated";
import type { TransformOptions } from "./index";
import type { HookReport, ReportMeta } from "./register";

type Transform = typeof import("./index");

/** Extensions whose handlers get the wrapper; `.cjs` (and `.cts` under Node's type stripping) use `.js`'s. */
export const CJS_EXTENSIONS = [".js", ".cjs", ".ts", ".cts"] as const;

/** The files the wrapper rewrites (by their own extension, whatever handler loads them). */
const IN_SCOPE_EXT = /\.(c?js|c?ts)$/;

/** Same limit as the ESM hook: larger sources are generated code, not parsed. */
const MAX_SOURCE_BYTES = 1024 * 1024;

export interface CommonJSLayerOptions extends TransformOptions {
  report: (r: HookReport) => void;
  /** Keep compiled output for the request path (RegisterOptions.retainGenerated). */
  retainGenerated?: boolean;
  /** The transform cache's directory (RegisterOptions.cacheDir); unset: no cache. */
  cacheDir?: string;
  /** Report files with nothing to wrap too (`type: "none"`). */
  verbose?: boolean;
}

interface Entry {
  file: string;
  /** The rewritten source once computed: a string, or null for "load the file as it is". */
  out?: string | null;
  read: boolean;
  fns: number;
  /** Debug log facts: cache outcome, ms spent in rewrite(), and whether this file loaded TypeScript. */
  meta?: ReportMeta;
  /** Parsed (or answered by the cache) with nothing to wrap. */
  none?: boolean;
  /** What the read answered (the file, or its rewrite): compiled output differs from it. */
  handed?: string;
}

let tx: Transform | undefined;

/**
 * The pure transform (dist/index.js, next to the built register.js), required on the first file the
 * layer looks at. A computed path, so the bundler leaves it out of register.js.
 */
function transform(): Transform {
  tx ??= require(path.join(__dirname, "index.js")) as Transform;
  return tx;
}

const win = process.platform === "win32";
const keyOf = (p: string) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));

/** A readFileSync path argument as a string; undefined for a file descriptor or anything odd. */
function pathArg(p: unknown): string | undefined {
  if (typeof p === "string") return p;
  if (p instanceof URL) return p.protocol === "file:" ? fileURLToPath(p) : undefined;
  if (Buffer.isBuffer(p)) return p.toString();
  return undefined;
}

/**
 * Install the layer. Never throws; returns a disposer that puts back every handler and Module._load it
 * still owns (one another loader wrapped stays, and passes straight through).
 */
export function installCommonJS(opts: CommonJSLayerOptions): () => void {
  const M = nodeModule as any;
  const exts = M?._extensions;
  if (!exts || typeof M._load !== "function") return () => {};

  const o: TransformOptions = { root: opts.root, include: opts.include, exclude: opts.exclude, preset: "node" };
  // Node hands the CommonJS loader real paths (symlinks and Windows junctions resolved); the root comes
  // from process.cwd(), which keeps the path the shell was in.
  let real: TransformOptions | undefined;
  try {
    const r = fs.realpathSync.native(o.root);
    if (r !== o.root) real = { ...o, root: r };
  } catch {
    /* the root as given */
  }
  const inside = (root: string, file: string) => {
    const rel = path.relative(root, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const optsFor = (file: string): TransformOptions =>
    real && !inside(o.root, file) && inside(real.root, file) ? real : o;
  const relOf = (file: string) => path.relative(optsFor(file).root, file).split(path.sep).join("/");
  const report = (r: HookReport) => {
    try {
      opts.report(r);
    } catch {
      /* a report never breaks the app */
    }
  };

  let disabled = false;
  // Opened on the first in-scope file (not at install: the transform's own files load first).
  let cache: ReturnType<typeof openCache>;
  let cacheOpened = false;
  const theCache = () => {
    if (!cacheOpened) {
      cacheOpened = true;
      cache = openCache(opts.cacheDir, __dirname, o.root);
    }
    return cache;
  };
  /** Files whose handler is running now, by keyOf(filename). */
  const active = new Map<string, Entry>();
  /** Our wrappers, each with the handler it wraps. */
  const ours = new WeakMap<Function, Function>();

  // ── the scoped fs.readFileSync ─────────────────────────────────────────
  // `swapped` goes on top of fs.readFileSync for a swap and comes off after it, delegating to `prevRead`
  // (what was there when it went on). A patcher that wraps fs.readFileSync while ours is on top captures
  // ours as its "previous": ours then stays in the chain under it for good (`buried`) and is never put on
  // top again, where it would delegate to that patcher, which calls ours, and so on.
  const installRead = fs.readFileSync;
  let prevRead: typeof fs.readFileSync = installRead;
  /** `swapped` is in the fs.readFileSync chain (on top, or buried under another patcher's wrapper). */
  let inChain = false;
  let buried = false;
  /** Calls of `swapped` running now: a nested one (a chain that leads back to ours) reads straight through. */
  let depth = 0;
  const swapped = function readFileSync(this: unknown, p: unknown, options?: unknown) {
    // biome-ignore lint/style/noArguments: forward exactly what the caller passed
    const args = arguments as unknown as Parameters<typeof fs.readFileSync>;
    if (depth > 0) return (installRead as any).apply(this, args);
    depth++;
    try {
      return answer(this, p, options, args);
    } finally {
      depth--;
    }
  } as typeof fs.readFileSync;

  function answer(self: unknown, p: unknown, options: unknown, args: Parameters<typeof fs.readFileSync>) {
    const e = active.size ? entryFor(p) : undefined;
    if (!e) return (prevRead as any).apply(self, args);
    const flag = options && typeof options === "object" ? (options as { flag?: unknown }).flag : undefined;
    if (flag !== undefined && flag !== "r") return (prevRead as any).apply(self, args);
    const r = (prevRead as any).apply(self, args) as string | Buffer;
    const enc = typeof options === "string" ? options : (options as { encoding?: unknown } | undefined)?.encoding;
    const utf8 = typeof enc === "string" && /^utf-?8$/i.test(enc);
    let src: string | undefined;
    if (Buffer.isBuffer(r)) src = r.toString("utf8");
    else if (typeof r === "string" && utf8) src = r;
    if (src === undefined) return r;
    e.read = true;
    if (e.out === undefined) e.out = rewrite(e, src);
    if (opts.retainGenerated) e.handed = e.out ?? src;
    if (e.out == null) return r;
    return Buffer.isBuffer(r) ? Buffer.from(e.out, "utf8") : e.out;
  }

  function entryFor(p: unknown): Entry | undefined {
    const s = pathArg(p);
    return s === undefined ? undefined : active.get(keyOf(s));
  }

  function swapIn() {
    if (inChain) return;
    inChain = true;
    if (fs.readFileSync === swapped) return;
    prevRead = fs.readFileSync;
    fs.readFileSync = swapped;
  }
  function swapOut() {
    if (!inChain || buried) return;
    if (fs.readFileSync === swapped) {
      fs.readFileSync = prevRead;
      inChain = false;
    } else {
      // Someone patched it on top meanwhile: leave theirs, and ours under it (it passes through when idle).
      buried = true;
    }
  }

  /** The rewritten source of an in-scope file, or null to load it as it is. Never throws. */
  function rewrite(e: Entry, src: string): string | null {
    const file = e.file;
    const t0 = performance.now();
    // Only with `verbose`: reports stay as they were without it.
    const meta = (hit: boolean | undefined): ReportMeta => {
      if (!opts.verbose) return {};
      const m: ReportMeta = { mode: "cjs", ms: performance.now() - t0 };
      if (hit !== undefined) m.cache = hit ? "hit" : "miss";
      if (claimTsLoaded(Boolean(tx?.typescriptLoaded()))) m.ts = "main";
      return m;
    };
    try {
      const t = transform();
      const fo = optsFor(file);
      if (Buffer.byteLength(src, "utf8") > MAX_SOURCE_BYTES) {
        if (t.shouldTrace(file, "", fo))
          report({ type: "refused", file: relOf(file), reason: "large", ...meta(undefined) });
        return null;
      }
      if (!t.shouldTrace(file, src, fo)) return null;
      // The prescan before the cache: a file with no export shape costs neither a hash nor a read.
      if (!t.mayHaveCommonJSTargets(src)) return null;
      const { result: res, hit } = cached(
        theCache(),
        "cjs",
        file,
        src,
        fo,
        () => {
          const x = t.transformCommonJS(src, file, fo);
          return x ? { kind: "wrapped", code: x.code, fns: x.fns } : { kind: "none" };
        },
        undefined,
        // A none is kept only when TypeScript loaded: one that failed to load must not outlive this start.
        () => t.typescriptLoaded(),
      );
      e.meta = meta(hit);
      if (res.kind !== "wrapped") {
        e.none = true;
        return null;
      }
      e.fns = res.fns;
      return res.code;
    } catch (err) {
      report({
        type: "error",
        file: relOf(file),
        message: err instanceof Error ? err.message : String(err),
        ...meta(undefined),
      });
      return null;
    }
  }

  /** In scope by path alone (the source-dependent checks run when the handler reads it). */
  function inScope(file: string): boolean {
    // Path checks first: the transform module itself (and anything outside the root) loads through
    // here too, before the transform is there to ask.
    if (!IN_SCOPE_EXT.test(file) || /[\\/]node_modules[\\/]/.test(file)) return false;
    if (!inside(o.root, file) && !(real && inside(real.root, file))) return false;
    // Hoplens' own build (a workspace checkout under the app root is not in node_modules).
    if (inside(__dirname, file)) return false;
    try {
      return transform().shouldTrace(file, "", optsFor(file));
    } catch {
      return false;
    }
  }

  /** After the handler: report what happened to the file. */
  function settle(e: Entry) {
    if (e.read) {
      if (e.out != null) report({ type: "wrapped", file: relOf(e.file), fns: e.fns, ...e.meta });
      else if (e.none && opts.verbose) report({ type: "none", file: relOf(e.file), ...e.meta });
      return;
    }
    // Never read: Node already held the source (its ESM loader read it). Report it only when it looks
    // like it has something to wrap; a regex, so no TypeScript loads for it. The in-thread ESM step
    // (register.ts, sync hooks) got that source and already reported the file.
    if (esmHandledCommonJS(e.file)) return;
    try {
      const src = installRead.call(fs, e.file, "utf8") as string;
      const t = transform();
      if (t.mayHaveCommonJSTargets(src) && t.shouldTrace(e.file, src, optsFor(e.file))) {
        report({
          type: "refused",
          file: relOf(e.file),
          reason: "esm-loader",
          ...(opts.verbose ? { mode: "cjs" as const } : {}),
        });
      }
    } catch {
      /* unreadable: nothing to say */
    }
  }

  // ── the handler wrapper ────────────────────────────────────────────────
  function wrap(inner: Function): Function {
    const handler = function (this: unknown, mod: unknown, filename: unknown) {
      // biome-ignore lint/style/noArguments: forward exactly what Node passed
      const args = arguments;
      if (disabled || typeof filename !== "string") return inner.apply(this, args);
      const key = keyOf(filename);
      // A second copy of this wrapper further down the chain (another loader wrapped ours): the outer
      // one already scoped the read.
      if (active.has(key) || !inScope(filename)) return inner.apply(this, args);
      const e: Entry = { file: filename, read: false, fns: 0 };
      const end = () => {
        if (active.get(key) !== e) return;
        active.delete(key);
        if (!active.size) swapOut();
      };
      active.set(key, e);
      swapIn();
      const compile = endAtCompile(mod, end, (content) => {
        // Only after a read: a module whose source Node already held was never handed anything.
        if (opts.retainGenerated && e.handed !== undefined && content !== e.handed) retainGenerated(filename, content);
      });
      try {
        return inner.apply(this, args);
      } finally {
        end();
        if (compile && (mod as any)._compile === compile) Reflect.deleteProperty(mod as object, "_compile");
        settle(e);
      }
    };
    ours.set(handler, inner);
    return handler;
  }

  /**
   * The swap ends when the handler hands the source to `module._compile`, before the module's own code
   * runs: its reads (its own file included), and everything it requires, see the plain fs.readFileSync.
   * An own property on this one module object, gone before compile runs; Module.prototype is never
   * touched. Undefined when the module already has an own _compile (another loader's, pirates-style).
   */
  function endAtCompile(mod: unknown, end: () => void, seen: (content: unknown) => void): Function | undefined {
    if (!mod || typeof mod !== "object" || Object.prototype.hasOwnProperty.call(mod, "_compile")) return undefined;
    const proto = (mod as any)._compile;
    if (typeof proto !== "function") return undefined;
    const compile = function _compile(this: unknown, content?: unknown) {
      end();
      try {
        seen(content);
      } catch {
        /* never in the way of a compile */
      }
      if ((mod as any)._compile === compile) Reflect.deleteProperty(mod as object, "_compile");
      // biome-ignore lint/style/noArguments: forward exactly what the handler passed
      return proto.apply(this, arguments);
    };
    try {
      Object.defineProperty(mod, "_compile", { value: compile, configurable: true, writable: true, enumerable: false });
    } catch {
      return undefined;
    }
    return compile;
  }

  /**
   * What a handler slot read back right after we put our wrapper in it, when that was not our wrapper
   * (an accessor that wraps every handler assigned to it, append-transform's contract: nyc, istanbul).
   * Ours is inside it, so it is not wrapped again; a handler another loader installs later is.
   */
  const settled = new WeakSet<Function>();
  /** Slots whose getter hands out a new function on every read: healed once, then left alone. */
  const contested = new Set<string>();
  function heal() {
    if (disabled) return;
    for (const ext of CJS_EXTENSIONS) {
      if (contested.has(ext)) continue;
      const h = exts[ext];
      if (typeof h !== "function" || ours.has(h) || settled.has(h)) continue;
      const w = wrap(h);
      exts[ext] = w;
      const back = exts[ext];
      if (back === w) continue;
      if (typeof back === "function" && exts[ext] === back) settled.add(back);
      else contested.add(ext);
    }
  }

  const prevLoad = M._load;
  const load = function _load(this: unknown) {
    try {
      heal();
    } catch {
      /* never in the way of a require */
    }
    // biome-ignore lint/style/noArguments: forward exactly what the caller passed
    return prevLoad.apply(this, arguments);
  };
  try {
    heal();
    M._load = load;
  } catch {
    /* a frozen Module: nothing installed */
  }

  return () => {
    disabled = true;
    try {
      if (M._load === load) M._load = prevLoad;
      for (const ext of CJS_EXTENSIONS) {
        const h = exts[ext];
        const inner = typeof h === "function" ? ours.get(h) : undefined;
        if (inner) exts[ext] = inner;
      }
      swapOut();
    } catch {
      /* best effort */
    }
  };
}
