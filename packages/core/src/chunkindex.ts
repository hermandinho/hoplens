// Module-level diff of the dev build output (plan 3.5 / WP9c).
//
// epoch.ts sees *that* server code was rebuilt (chunk files written). This index answers *what* changed:
// it keeps a hash of every module's compiled code, keyed by the bundler's module id, and on a rebuild
// re-parses only the chunk files that were written and compares. That gives three things the file
// watcher can't:
//   * a rebuild whose modules all hash the same (format-on-save that only moved whitespace, a `touch`, a
//     client-only edit that still rewrote server chunks) is a no-op and creates no epoch;
//   * the changed modules name the source files (`[project]/src/lib/store.ts [app-route] (ecmascript)`),
//     so attribution works even when the watcher missed the save (`via: "chunk-diff"`);
//   * route entry files list the chunks they load, so route -> chunks -> modules tells which compiled
//     routes actually contain a changed module (type-only imports are erased by the bundler, which an
//     import graph can't see).
//
// Everything sits behind a format sniff. Turbopack (Next 15/16, array and object chunk shapes, the
// `R.c(...)` entry files) and webpack (`/***/ "(rsc)/./src/x.ts":` module tables, eval source maps
// stripped) are understood; any other file written during a rebuild makes the diff untrusted, and the
// caller falls back to the old behaviour (bump, attribute from the watcher or chunk names).
//
// Cost: nothing per request. A one-time background prime reads the existing output (async, batched,
// byte-capped) so the first edit has a baseline; a rebuild re-reads only the written files, from the
// finalize of the request that noticed the rebuild (after the response finished).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ChunkFormat =
  /** Turbopack chunk: `module.exports = [ "id", ((__turbopack_context__) => {...}), ... ]` (or `{ "id": ... }`). */
  | "turbopack-chunk"
  /** Turbopack entry (`app/<route>/route.js`): `var R=require(".../[turbopack]_runtime.js")(...); R.c("...")`. */
  | "turbopack-entry"
  /** The Turbopack runtime itself; carries no app modules. */
  | "turbopack-runtime"
  /** Webpack server bundle with a `/***\/ "id":` module table. */
  | "webpack"
  | "unknown";

/** Look at a written build-output file and say which format it is. Exported for tests. */
export function sniffChunkFormat(text: string, file = ""): ChunkFormat {
  const base = path.basename(file);
  if (/^\[turbopack\]_runtime\.js$/.test(base) || /^var RUNTIME_PUBLIC_PATH\b/m.test(text.slice(0, 2000)))
    return "turbopack-runtime";
  const head = text.slice(0, 4000);
  if (/require\([^)]*\[turbopack\]_runtime\.js["']\)/.test(head)) return "turbopack-entry";
  if (!text.trim()) return "turbopack-chunk"; // Next writes empty files (client-components-ssr.js)
  if (/^\(globalThis\[?["']?TURBOPACK/.test(head) && /__turbopack_context__/.test(text)) return "turbopack-chunk";
  if (
    /^(?:\(\(\)=>\{"use strict";)?module\.exports\s*=\s*[[{]/m.test(head) &&
    /__turbopack_context__|__turbopack_require__/.test(text)
  )
    return "turbopack-chunk";
  if (/^module\.exports\s*=\s*\[\s*\]\s*;?\s*$/m.test(head)) return "turbopack-chunk"; // an empty chunk
  if (/__webpack_require__/.test(text) && /^\/\*{3}\/ "[^"\n]+":\s*$/m.test(text)) return "webpack";
  return "unknown";
}

export interface ParsedChunk {
  format: ChunkFormat;
  /** module id -> hash of its compiled code. */
  modules: Map<string, string>;
  /** Other output files this one loads (Turbopack `R.c`, webpack `vendor-chunks/*`), as written. */
  loads: string[];
}

const TP_HEADER = /^"(\[[^"\n]*)"\s*[,:]\s*\(/gm;
const WP_HEADER = /^\/\*{3}\/ "([^"\n]+)":\s*$/gm;
const SOURCE_MAP_COMMENT = /\/\/[#@] source(?:Mapping)?URL=[^\n"'\\]*/g;

function hash(s: string): string {
  return createHash("sha1").update(s).digest("base64");
}

function splitModules(text: string, re: RegExp): Map<string, string> {
  const out = new Map<string, string>();
  const heads: { id: string; start: number; end: number }[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text))
    heads.push({ id: m[1]!, start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < heads.length; i++) {
    const body = text.slice(heads[i]!.end, i + 1 < heads.length ? heads[i + 1]!.start : text.length);
    // Where a module sits in its chunk (first, last, inside a strict-mode group) must not change its
    // hash: the same module is often in several chunks.
    out.set(heads[i]!.id, hash(body.replace(/,?\s*$/, "")));
  }
  return out;
}

/** Turbopack's chunk scaffolding around the modules: strict-mode group lines and the closing bracket. */
function stripTurbopackScaffold(code: string): string {
  return code
    .replace(/^\(\(\)=>\{"use strict";return\[\s*$/gm, "")
    .replace(/^\]\}\)\(\),?\s*$/gm, "")
    .replace(/^\(\(\)=>\{"use strict";(?=module\.exports)/m, "")
    .replace(/\n[\]}]\s*\)?;?(?:\}\)\(\);?)?\s*$/, "\n");
}

/** Parse one build-output file. Exported for tests. */
export function parseChunk(text: string, file = ""): ParsedChunk {
  const format = sniffChunkFormat(text, file);
  // The chunk's own `//# sourceMappingURL=` (and webpack's per-module eval source maps) change on
  // any save, formatting included; the code around them is what counts.
  const code = text.replace(SOURCE_MAP_COMMENT, "");
  switch (format) {
    case "turbopack-chunk":
      return { format, modules: splitModules(stripTurbopackScaffold(code), TP_HEADER), loads: [] };
    case "turbopack-entry": {
      const loads: string[] = [];
      for (const m of code.matchAll(/\bR\.c\(\s*"([^"\n]+)"\s*\)/g)) loads.push(m[1]!);
      return { format, modules: new Map(), loads };
    }
    case "webpack": {
      const loads: string[] = [];
      const x = /__webpack_require__\.X\(\s*0\s*,\s*\[([^\]]*)\]/.exec(code);
      if (x) for (const m of x[1]!.matchAll(/"([^"\n]+)"/g)) loads.push(m[1]!);
      return { format, modules: splitModules(code, WP_HEADER), loads };
    }
    default:
      return { format, modules: new Map(), loads: [] };
  }
}

/**
 * The source path inside a module id, or undefined for externals and runtime modules:
 * `[project]/examples/app/src/lib/store.ts [app-route] (ecmascript)` -> `examples/app/src/lib/store.ts`
 * (relative to Turbopack's root, which may be a monorepo root), `(rsc)/./src/lib/store.ts` -> `src/lib/store.ts`.
 * Exported for tests.
 */
export function moduleSourcePath(id: string): string | undefined {
  const tp = /^\[project\]\/(.+?)(?: \[|$| \{|\?)/.exec(id);
  if (tp) return tp[1];
  if (id.startsWith("[")) return undefined; // [externals], [turbopack], [next]...
  const wp = /^(?:\([^)]*\)\/)?\.\/(.+?)(?:\?.*)?$/.exec(id);
  if (wp) return wp[1];
  return undefined;
}

/**
 * Route template for a route entry file relative to the server output dir:
 * `app/api/orders/[id]/route.js` -> `/api/orders/[id]`, `app/(shop)/page.js` -> `/`,
 * `pages/api/x.js` -> `/api/x`. Undefined for anything that isn't a route entry. Exported for tests.
 */
export function routeFromEntry(rel: string): string | undefined {
  const n = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const app = /^app\/(.*?)\/?(?:route|page)\.[cm]?js$/.exec(n);
  if (app) {
    const segs = app[1]!.split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return `/${segs.join("/")}`;
  }
  const pages = /^pages\/(.+)\.[cm]?js$/.exec(n);
  if (pages && !/^_(app|document|error)$/.test(pages[1]!)) {
    const p = pages[1]!.replace(/(^|\/)index$/, "");
    return `/${p}`;
  }
  return undefined;
}

/** The output dirs holding compiled server code (Next 16 dev first). */
export function serverDirs(root: string, distDir: string): string[] {
  const base = path.join(root, distDir);
  return [path.join(base, "dev", "server"), path.join(base, "server")];
}

export interface ChunkDiff {
  /**
   * True when every written file was understood and a baseline existed, so an empty `changed` really
   * means "no module code changed". False: the caller falls back to its old rules.
   */
  trusted: boolean;
  /** Module ids whose code changed, appeared or disappeared, sorted. */
  changed: string[];
  /** Project-relative source files (`/` separators) behind `changed`, sorted. */
  files: string[];
  /** Changed modules outside the project (node_modules, other workspace packages), sorted, capped. */
  external: string[];
  /** Route templates of compiled routes whose chunks contain a changed module, sorted. */
  routes: string[];
  /** Route templates of every compiled route the index knows, sorted. */
  compiled: string[];
}

/** Raw result of one ChunkIndex.update(). */
export interface ChunkUpdate {
  trusted: boolean;
  /** Module ids never seen before (a new file, or a route/layer compiled for the first time). */
  added: string[];
  /** Module ids whose code hash changed: an edit. */
  modified: string[];
  /** Module ids no chunk carries any more. */
  removed: string[];
}

export interface ChunkIndexOptions {
  /** Files larger than this are never parsed (a change in one makes the diff untrusted). Default 8 MB. */
  maxFileBytes?: number;
  /** Bytes read by the background prime per output dir. Default 96 MB. */
  maxPrimeBytes?: number;
  /** Prime the existing output in the background (setImmediate batches). Default true. */
  prime?: boolean;
}

interface Entry {
  route: string;
  /** Absolute paths of the chunks this entry loads (plus itself for webpack). */
  chunks: string[];
  /** File mtime when read (the sweep re-reads an entry whose mtime moved). */
  mtimeMs: number;
}

const MAX_LIST = 50;

export class ChunkIndex {
  /**
   * module id -> every code hash seen for it. Usually one, but Next can build the same id twice with
   * different code (another pnpm peer variant of `next` for the proxy or instrumentation), so a module
   * is compared with its own chunk's previous copy first and with this set only in a chunk never seen.
   */
  private readonly known = new Map<string, Set<string>>();
  /** chunk abs path -> module id -> code hash. */
  private readonly chunkMods = new Map<string, Map<string, string>>();
  /** entry abs path -> route + chunks. */
  private readonly entries = new Map<string, Entry>();
  /** dir -> prime state. */
  private readonly priming = new Map<string, { done: boolean; ident: string }>();
  private readonly fileOf = new Map<string, string | null>();
  private readonly dirs: string[];
  private readonly maxFileBytes: number;
  private readonly maxPrimeBytes: number;
  private closed = false;

  constructor(
    private readonly root: string,
    distDir: string,
    opts: ChunkIndexOptions = {},
  ) {
    this.dirs = serverDirs(root, distDir);
    this.maxFileBytes = opts.maxFileBytes ?? 8 * 1024 * 1024;
    this.maxPrimeBytes = opts.maxPrimeBytes ?? 96 * 1024 * 1024;
    if (opts.prime !== false) for (const d of this.dirs) this.prime(d);
  }

  /** True once every existing output dir has been primed. */
  get primed(): boolean {
    for (const d of this.dirs) {
      const p = this.priming.get(d);
      if (p && !p.done) return false;
    }
    return true;
  }

  close(): void {
    this.closed = true;
  }

  /**
   * An output dir was (re)created or its watcher re-armed (e.g. after `rm -rf .next`): forget its chunk
   * and entry maps and prime it again. Module hashes are kept, so the rewrite of unchanged code that
   * follows a wipe is still recognised as unchanged.
   */
  rearm(dir: string): void {
    const abs = path.resolve(dir);
    const state = this.priming.get(abs);
    if (state && state.ident === dirIdent(abs)) return; // same directory as primed: nothing was lost
    const prefix = abs + path.sep;
    for (const k of [...this.chunkMods.keys()]) if (k.startsWith(prefix)) this.chunkMods.delete(k);
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
    this.prime(dir);
  }

  /** Read the existing output of `dir` in the background (only fills what update() hasn't seen). */
  prime(dir: string): void {
    const abs = path.resolve(dir);
    const ident = dirIdent(abs);
    if (!ident) {
      this.priming.delete(abs);
      return;
    }
    const state = { done: false, ident };
    this.priming.set(abs, state);
    // Next 16 dev writes `<distDir>/dev/server`; `<distDir>/server` next to it is a production build's
    // minified output, never rewritten by dev. Don't spend the prime on it.
    if (abs === path.resolve(this.dirs[1]!) && dirIdent(this.dirs[0]!)) {
      state.done = true;
      return;
    }
    const stack = [abs];
    const entries: string[] = [];
    let chunks: string[] = [];
    let phase: "walk" | "entries" | "chunks" = "walk";
    let next = 0;
    let budget = this.maxPrimeBytes;
    let stepBytes = 0;
    const read = (f: string) => {
      if (this.chunkMods.has(f) || this.entries.has(f)) return;
      let text: string;
      try {
        const st = fs.statSync(f);
        if (st.size > this.maxFileBytes || st.size > budget) return;
        budget -= st.size;
        stepBytes += st.size;
        text = fs.readFileSync(f, "utf8");
      } catch {
        return;
      }
      this.ingest(f, parseChunk(text, f), true);
    };
    // Order matters: entries first, then the chunks they load, then the rest. Next leaves stale chunks
    // from earlier builds (another pnpm peer variant, say) next to live ones under the same module ids,
    // and the prime keeps the first hash it sees, so the live code must come first.
    const step = () => {
      if (this.closed || this.priming.get(abs) !== state) return;
      let work = 32;
      stepBytes = 0;
      // Sync reads + hashing on the app's thread: keep each turn small (~1 MB) so requests interleave.
      while (work-- > 0 && stepBytes < 1024 * 1024) {
        if (phase === "walk") {
          const d = stack.pop();
          if (d === undefined) {
            phase = "entries";
            continue;
          }
          let list: fs.Dirent[];
          try {
            list = fs.readdirSync(d, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of list) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile() && /\.[cm]?js$/i.test(e.name) && !/manifest/i.test(e.name))
              (path.relative(abs, p).split(path.sep).includes("chunks") ? chunks : entries).push(p);
          }
        } else if (phase === "entries") {
          const f = entries[next++];
          if (f !== undefined) {
            read(f);
            continue;
          }
          const live = new Set<string>();
          for (const e of this.entries.values()) for (const c of e.chunks) live.add(c);
          chunks = [...chunks.filter((c) => live.has(c)), ...chunks.filter((c) => !live.has(c))];
          phase = "chunks";
          next = 0;
        } else {
          const f = chunks[next++];
          if (f === undefined) {
            state.done = true;
            return;
          }
          read(f);
        }
      }
      setImmediate(step).unref?.();
    };
    setImmediate(step).unref?.();
  }

  /**
   * Re-read the build-output files written since the last call and diff their modules against what was
   * seen before. `overflow` = the watcher dropped names, so the set is incomplete (untrusted).
   */
  update(paths: readonly string[], overflow = false): ChunkUpdate {
    let trusted = !overflow && this.primed;
    const added = new Set<string>();
    const modified = new Set<string>();
    const removed = new Set<string>();
    // fs.watch can miss writes (measured on Windows under Turbopack's write bursts). Route entries are
    // few and small: re-read any whose mtime moved, then any chunk an entry loads that was never read.
    const todo = new Set(paths.map((p) => path.resolve(p)));
    for (const e of this.sweepEntries()) todo.add(e);
    const seenFiles = new Set<string>();
    let pass = 0;
    while (todo.size && pass++ < 2) {
      const batch = [...todo].filter((f) => !seenFiles.has(f));
      todo.clear();
      for (const f of batch) {
        seenFiles.add(f);
        trusted = this.updateFile(f, added, modified, removed) && trusted;
      }
      for (const e of this.entries.values())
        for (const c of e.chunks) if (!this.chunkMods.has(c) && !seenFiles.has(c) && fs.existsSync(c)) todo.add(c);
    }
    for (const id of removed) this.known.delete(id);
    return { trusted, added: [...added].sort(), modified: [...modified].sort(), removed: [...removed].sort() };
  }

  /** Entry files under the primed output dirs that are new or whose mtime moved. */
  private sweepEntries(): string[] {
    const out: string[] = [];
    for (const [dir, state] of this.priming) {
      if (!state.done || (dir === path.resolve(this.dirs[1]!) && dirIdent(this.dirs[0]!))) continue;
      const stack = [path.join(dir, "app"), path.join(dir, "pages")];
      let budget = 2000;
      while (stack.length && budget-- > 0) {
        const d = stack.pop()!;
        let list: fs.Dirent[];
        try {
          list = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of list) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile() && routeFromEntry(path.relative(dir, p).split(path.sep).join("/"))) {
            const known = this.entries.get(p);
            let m = 0;
            try {
              m = fs.statSync(p).mtimeMs;
            } catch {
              continue;
            }
            if (!known || known.mtimeMs !== m) out.push(p);
          }
        }
      }
    }
    return out;
  }

  /** Read one written file and fold its modules into the sets. False = not understood (untrusted). */
  private updateFile(f: string, added: Set<string>, modified: Set<string>, removed: Set<string>): boolean {
    if (!/\.[cm]?js$/i.test(f) || /manifest/i.test(path.basename(f))) return true;
    let text: string | undefined;
    try {
      const st = fs.statSync(f);
      if (st.size > this.maxFileBytes) return false;
      text = fs.readFileSync(f, "utf8");
    } catch {
      text = undefined; // deleted
    }
    if (text === undefined) {
      // A deleted chunk: a real removal also rewrites the importer, so a delete alone changes nothing.
      this.chunkMods.delete(f);
      this.entries.delete(f);
      return true;
    }
    const parsed = parseChunk(text, f);
    if (parsed.format === "unknown") return false;
    const before = this.chunkMods.get(f);
    for (const [id, h] of parsed.modules) {
      const prev = before?.get(id);
      if (prev !== undefined) {
        if (prev !== h) modified.add(id);
        continue;
      }
      // A chunk never seen before. A known module with another hash is an edit, except in
      // node_modules: Next builds some package modules twice under one id (pnpm peer variants of
      // `next` for the proxy / instrumentation), and those differ without anything being edited.
      const seen = this.known.get(id);
      if (!seen || seen.has(h)) {
        if (!seen) added.add(id);
      } else if (id.includes("/node_modules/")) added.add(id);
      else modified.add(id);
    }
    if (before)
      for (const id of before.keys()) if (!parsed.modules.has(id) && !this.stillLoaded(id, f)) removed.add(id);
    this.ingest(f, parsed, false);
    return true;
  }

  /** Files, packages and compiled routes behind a set of changed module ids. */
  describe(changedIds: Iterable<string>, trusted = true): ChunkDiff {
    const ids = [...new Set(changedIds)].sort();
    const changed = new Set(ids);
    const files = new Set<string>();
    const external = new Set<string>();
    for (const id of ids) {
      const rel = this.projectFile(id);
      if (rel) files.add(rel);
      else {
        const src = moduleSourcePath(id);
        if (src && !isInternal(src)) external.add(packageOf(src));
      }
    }
    const routes = new Set<string>();
    const compiled = new Set<string>();
    for (const e of this.entries.values()) {
      compiled.add(e.route);
      if (routes.has(e.route) || !changed.size) continue;
      for (const c of e.chunks) {
        const mods = this.chunkMods.get(c);
        if (mods && ids.some((id) => mods.has(id))) {
          routes.add(e.route);
          break;
        }
      }
    }
    return {
      trusted,
      changed: ids,
      files: [...files].sort(),
      external: [...external].sort().slice(0, MAX_LIST),
      routes: [...routes].sort(),
      compiled: [...compiled].sort(),
    };
  }

  /** update() then describe() of everything it saw change. */
  diff(paths: readonly string[], overflow = false): ChunkDiff {
    const u = this.update(paths, overflow);
    return this.describe([...u.added, ...u.modified, ...u.removed], u.trusted);
  }

  /** Project-relative source file for a module id (undefined: external, runtime or outside the root). */
  projectFile(id: string): string | undefined {
    const hit = this.fileOf.get(id);
    if (hit !== undefined) return hit ?? undefined;
    const r = this.resolveFile(id);
    if (this.fileOf.size > 20000) this.fileOf.clear();
    this.fileOf.set(id, r ?? null);
    return r;
  }

  private resolveFile(id: string): string | undefined {
    const src = moduleSourcePath(id);
    if (!src || src.includes("node_modules/")) return undefined;
    // Turbopack ids are relative to its root, which in a monorepo is above the app: strip the longest
    // trailing run of the app root's own segments ("examples/next16-app/"), preferring a path that exists.
    const segs = path.resolve(this.root).replace(/\\/g, "/").split("/").filter(Boolean);
    let rel: string | undefined;
    for (let k = Math.min(segs.length, 8); k >= 1; k--) {
      const prefix = `${segs.slice(segs.length - k).join("/")}/`;
      if (src.startsWith(prefix)) {
        const stripped = src.slice(prefix.length);
        rel = exists(path.join(this.root, stripped)) || !exists(path.join(this.root, src)) ? stripped : src;
        break;
      }
    }
    // No prefix: Turbopack's root is the app root, or the module lives elsewhere in the workspace
    // (`packages/shared/src/x.ts`), which only counts if it is really under this root (or its dir is: a
    // deleted file).
    if (rel === undefined && (exists(path.join(this.root, src)) || exists(path.dirname(path.join(this.root, src)))))
      rel = src;
    if (rel === undefined || isInternal(rel)) return undefined;
    return rel;
  }

  private stillLoaded(id: string, except: string): boolean {
    for (const [c, mods] of this.chunkMods) if (c !== except && mods.has(id)) return true;
    return false;
  }

  private ingest(f: string, parsed: ParsedChunk, fromPrime: boolean): void {
    if (parsed.format === "turbopack-chunk" || parsed.format === "webpack") {
      if (fromPrime && this.chunkMods.has(f)) return; // update() saw a newer copy meanwhile
      this.chunkMods.set(f, parsed.modules);
      for (const [id, h] of parsed.modules) {
        let seen = this.known.get(id);
        if (!seen) this.known.set(id, (seen = new Set()));
        if (seen.size >= 8) seen.clear();
        seen.add(h);
      }
    }
    if (parsed.format === "turbopack-entry" || parsed.format === "webpack") {
      const route = this.entryRoute(f);
      if (!route) return;
      const base = this.outputBase(f);
      const chunks = parsed.loads.map((l) =>
        parsed.format === "webpack" ? path.join(this.serverDirOf(f) ?? base, `${l}.js`) : path.join(base, l),
      );
      if (parsed.format === "webpack") chunks.push(f);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(f).mtimeMs;
      } catch {
        /* gone again */
      }
      this.entries.set(f, { route, chunks, mtimeMs });
    }
  }

  private serverDirOf(f: string): string | undefined {
    for (const d of this.dirs) if (f.startsWith(path.resolve(d) + path.sep)) return path.resolve(d);
    return undefined;
  }

  /** Turbopack `R.c("server/chunks/x.js")` paths are relative to the server dir's parent. */
  private outputBase(f: string): string {
    const d = this.serverDirOf(f);
    return d ? path.dirname(d) : path.dirname(f);
  }

  private entryRoute(f: string): string | undefined {
    const d = this.serverDirOf(f);
    if (!d) return undefined;
    return routeFromEntry(path.relative(d, f));
  }
}

/** Generated or outside paths (`.next-internal/...`, `../x`) are never a source file or a package to name. */
function isInternal(rel: string): boolean {
  if (rel.includes("node_modules/")) return false;
  return rel.split("/").some((s) => s === ".." || s.startsWith("."));
}

/** `node_modules/.pnpm/x@1/node_modules/@scope/pkg/dist/a.js` -> `@scope/pkg`; other paths as-is. */
function packageOf(src: string): string {
  const i = src.lastIndexOf("node_modules/");
  if (i < 0) return src;
  const rest = src.slice(i + "node_modules/".length).split("/");
  return rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : (rest[0] ?? src);
}

/** Identity of a directory (changes when it is deleted and created again); "" when missing. Exported for epoch.ts. */
export function dirIdent(p: string): string {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? `${st.ino}:${st.birthtimeMs}` : "";
  } catch {
    return "";
  }
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}
