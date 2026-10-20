// Request path, Next dev (plan P6): which coverage scripts hold project code, and the text and source
// map V8 ran for each project file, for the two bundler shapes `next dev` runs on the server.
//
// Turbopack
//   - A chunk (`file:///<root>/<distDir>/dev/server/chunks/....js`) is one script holding many
//     modules: `module.exports = [ "<module id>", ((__turbopack_context__) => { ... }), ... ]`. Its
//     map is the sidecar `<chunk>.js.map` named by the chunk's last sourceMappingURL comment:
//     sectioned, one section per module, `file://` sources, sourcesContent the loader's output (the
//     file, plus Hoplens' trailer for a file the transform rewrote: a prefix, as srcmap.ts accepts).
//   - V8's text of a chunk is the file on disk, until Turbopack rewrites the chunk in place (lesson
//     15) after an edit. The edited module then runs as a separate eval'd script with
//     `//# sourceURL=<chunk url>?id=<module id>` and an inline sectioned map; its text is only in V8.
// webpack (`--webpack`, eval-source-map)
//   - One eval'd script per module per layer: `webpack-internal:///(rsc)/./src/x.ts`, an inline map
//     with absolute source paths. Its text is the JSON string literal of the module's `eval("...")`
//     in a bundle under `<distDir>/{dev/,}server`. The same URL comes back with a new script id after
//     a bundle reload, so scripts are keyed by id, never by URL.
// Dropped at once: about://React/* (React's fake owner-stack functions, named after app files), empty
// URLs (tooling `new Function` code: ajv, depd, tapable), node:, framework modules.
//
// The text V8 ran (never guessed):
//   - from disk only while it is provably the one V8 parsed: the script was first seen (in any take,
//     reset takes included) after the file's last write, and V8's own length of the script (its
//     top-level function's range, recorded the first time a take reports it) is the text's length;
//   - else, with HOPLENS_PATH_DEBUGGER=1, Debugger.getScriptSource (scriptsource.ts), after the final
//     take; a rewritten Turbopack chunk is then re-anchored module by module: the module's section of
//     the (rewritten) sidecar map applies to V8's text only where that module's text is found there,
//     once, byte for byte;
//   - else UNKNOWN 'stale-chunk' with the reason, when the bundler rewrote the file after V8 loaded it
//     (an edit); 'unmapped' when the text has no source map, or a chunk or its map cannot be read
//     (over TEXT_MAX, no sidecar map, a map missing, half written or locked: retried next capture);
//     'no-generated-text' when the bundles hold several texts for one module.
// Each map's sourcesContent for the file must be the file on disk (or start with it): that, not the
// file's mtime, vouches that the bundle was built from the file as it is now (`verified`).
//
// Which script holds a file: candidates are the kept scripts whose map names it (a webpack module
// names one file). The one that ran the file's code in this take wins; two that both ran it (a lib
// in both the rsc and the middleware layer) are UNKNOWN 'bundle-copies', and nothing is joined. None
// ran: the newest.
//
// A file under the server output is kept as a chunk only when it holds a project module (read once
// per script id, when a take first reports it): Next's framework chunks and webpack-runtime.js are
// dropped there. A chunk too large to read is kept, as it may hold one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptCoverage } from "./coverage";
import type { GeneratedLookup, ScriptText } from "./generated";
import { debuggerSources } from "./scriptsource";
import { type RawMap, inlineMap, lineStarts } from "./srcmap";

export type ScriptKind =
  /** A JavaScript file under the dist dir's server output (Turbopack chunks; read to see if it holds app modules). */
  | "chunk"
  /** A module Turbopack re-ran after an edit (`?id=`): its text is only in V8. */
  | "hmr"
  /** A webpack eval-source-map module of a project file. */
  | "webpack"
  /** A plain project file Node ran itself (a custom server). */
  | "file"
  /** Framework, node_modules or a dist-dir script outside the server output. */
  | "framework"
  /** React's about://React/* owner-stack fakes. */
  | "react"
  /** No URL: `new Function` / vm code. */
  | "empty"
  | "node"
  | "other";

const KEPT: ReadonlySet<ScriptKind> = new Set(["chunk", "hmr", "webpack", "file"]);

/** Script counts of the final take, and what the resolution cost. */
export interface ScriptCounts {
  /** Scripts V8 reported in the final take, per kind. */
  kinds: Partial<Record<ScriptKind, number>>;
  /** Kept scripts that hold at least one project file, and the project files they hold. */
  holding: number;
  files: number;
  /** Bundle / chunk / map files read from disk (cache misses). */
  reads: number;
  /** ms resolving (reads, map parses, the Debugger read when on). */
  ms: number;
}

/** Why no script is joined for a file although one may hold it. */
export interface NoScript {
  why: "bundle-copies" | "unmapped";
  detail: string;
}

export interface ResolvedScripts {
  /** The script holding `abs`'s code in this take, or why none is certain. */
  scriptFor(abs: string): ScriptCoverage | NoScript | undefined;
  /** The text V8 ran for (script, file), with its map. */
  lookup: GeneratedLookup;
  counts: ScriptCounts;
  warnings: string[];
  /** ms of the opt-in Debugger read, when it ran. */
  debuggerMs?: number;
}

/** The capture window's view of a bundler's scripts (RuntimeConfig.path.scripts). */
export interface PathScripts {
  /** Called at the start of each take whose counts are kept (the final take). */
  startTake?(): void;
  /** Keep a script in a take. Sees every script of every take: decided once per script id (a chunk is read then). */
  keep(url: string, script: ScriptCoverage): boolean;
  /** Map the final take's kept scripts to project files. Never throws. */
  resolve(scripts: readonly ScriptCoverage[], opts?: { debuggerSource?: boolean }): ResolvedScripts;
}

export interface BundledFs {
  readFile(file: string): string | undefined;
  stat(file: string): { mtimeMs: number; size: number } | undefined;
  exists(file: string): boolean;
  /** .js files under `dir` (recursive). */
  jsFiles(dir: string): string[];
}

const nodeFs: BundledFs = {
  readFile(f) {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return undefined;
    }
  },
  stat(f) {
    try {
      const s = fs.statSync(f);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  },
  exists(f) {
    try {
      return fs.existsSync(f);
    } catch {
      return false;
    }
  },
  jsFiles(dir) {
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith(".js")) out.push(p);
      }
    };
    walk(dir, 0);
    return out;
  },
};

export interface BundledOptions {
  root: string;
  /** Next's distDir (default `.next`). */
  distDir?: string;
  fs?: BundledFs;
  now?: () => number;
  /** The Debugger read (default scriptsource.ts debuggerSources). */
  debuggerRead?: typeof debuggerSources;
}

/** What the book remembers of a script id from the first take that reported it. */
interface Seen {
  kind: ScriptKind;
  url: string;
  /** When a take first reported it: the script was parsed before this. */
  seenAt: number;
  /** V8's length of the script's text (its top-level function's range end), once a take showed it. */
  len?: number;
  /** turbopack / file: the file on disk. webpack / hmr: the project file. */
  file?: string;
  /** A chunk: whether it holds a project module, decided once. */
  project?: boolean;
}

/** A section of a Turbopack chunk's sidecar map, for one project file. */
interface Section {
  abs: string;
  /** Offsets of the section in the chunk text: [start, end). */
  start: number;
  end: number;
  /** The section's map, sources absolute (other sources of a multi-source section stay foreign). */
  map: RawMap;
  /** sourcesContent for `abs` is there (the bundle can be checked against the file). */
  content: boolean;
}

interface Chunk {
  mtimeMs: number;
  size: number;
  /** Holds a project module (undefined: not known, the chunk was not read). */
  project?: boolean;
  /** Absolute project files of its module ids (when read). */
  files?: string[];
  /** Set when it holds project code: its text and project sections. */
  text?: string;
  sections?: Section[];
  mapId?: string;
  /** Why its project modules cannot be mapped (too large, no map, map unreadable). */
  skip?: string;
}

/** A missing text's UNKNOWN reason (generated.ts ScriptText). */
type MissingWhy = "stale-chunk" | "unmapped" | "no-generated-text";

const BOOK_MAX = 100_000;
const TEXT_MAX = 4 * 1024 * 1024;

const win = process.platform === "win32";
const norm = (p: string) => {
  const n = path.normalize(p);
  return win ? n.toLowerCase() : n;
};

/** Absolute path of a file:// URL, its query and hash dropped. */
function filePath(url: string): string | undefined {
  try {
    return fileURLToPath(url.replace(/[?#].*$/, ""));
  } catch {
    return undefined;
  }
}

/** The script's top-level function (offset 0, no name): its range end is V8's text length. */
function topLength(s: ScriptCoverage): number | undefined {
  for (const f of s.functions) {
    const r = f.ranges[0];
    if (f.functionName === "" && r && r.startOffset === 0) return r.endOffset;
  }
  return undefined;
}

/** The module id of a Turbopack HMR script (`?id=[project]/src/x.ts [app-route] (ecmascript)`). */
export function hmrModuleId(url: string): string | undefined {
  const q = url.indexOf("?");
  if (q < 0) return undefined;
  for (const part of url.slice(q + 1).split("&")) {
    if (!part.startsWith("id=")) continue;
    try {
      return decodeURIComponent(part.slice(3).replace(/\+/g, " "));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** `[project]/a/b.ts [app-route] (ecmascript)` -> `a/b.ts`; undefined for any other id. */
export function projectRest(id: string): string | undefined {
  const m = /^\[project\]\/(.+?)(?: \[[^\]]*\])?(?: \([^)]*\))?$/.exec(id);
  return m?.[1];
}

/** `webpack-internal:///(rsc)/./src/x.ts` -> `src/x.ts` (relative to the project root). */
export function webpackRest(url: string): string | undefined {
  const m = /^webpack-internal:\/\/\/(?:\([^)]*\)\/)?\.\/([^?#]+)/.exec(url);
  return m?.[1];
}

/** The bundled-script view of Next dev's server process (see the header). */
export class BundledScripts implements PathScripts {
  readonly root: string;
  readonly distDir: string;
  private readonly fs: BundledFs;
  private readonly now: () => number;
  private readonly debuggerRead: typeof debuggerSources;
  private readonly normRoot: string;
  private readonly normDist: string;
  private readonly book = new Map<string, Seen>();
  private tally: Partial<Record<ScriptKind, number>> = {};
  private readonly chunks = new Map<string, Chunk>();
  /** `[project]/<rest>` -> absolute path (the Turbopack root can be an ancestor of the app root). */
  private readonly rests = new Map<string, string | null>();
  /** Bundle file -> its project eval literals (url -> text), by mtime + size. */
  private readonly bundles = new Map<string, { mtimeMs: number; size: number; evals: Map<string, string> }>();
  private reads = 0;

  constructor(opts: BundledOptions) {
    this.root = path.resolve(opts.root);
    this.distDir = path.resolve(this.root, opts.distDir ?? ".next");
    this.fs = opts.fs ?? nodeFs;
    this.now = opts.now ?? Date.now;
    this.debuggerRead = opts.debuggerRead ?? debuggerSources;
    this.normRoot = norm(this.root) + path.sep;
    this.normDist = norm(this.distDir) + path.sep;
  }

  /** A project source file: under the root, outside node_modules, the dist dir and Hoplens' state. */
  isProjectFile(abs: string): boolean {
    const n = norm(abs);
    if (!n.startsWith(this.normRoot) || n.startsWith(this.normDist)) return false;
    return !/[\\/](node_modules|\.next|\.hoplens)[\\/]/i.test(n.slice(this.normRoot.length - 1));
  }

  /** The kind of a script URL (no file system access). Exported through the class for tests. */
  classify(url: string): { kind: ScriptKind; file?: string } {
    if (!url) return { kind: "empty" };
    if (url.startsWith("node:")) return { kind: "node" };
    if (url.startsWith("about:")) return { kind: "react" };
    if (url.startsWith("webpack-internal:")) {
      const rest = webpackRest(url);
      if (!rest || rest.startsWith("../")) return { kind: "framework" };
      const abs = path.join(this.root, rest);
      return this.isProjectFile(abs) ? { kind: "webpack", file: abs } : { kind: "framework" };
    }
    if (!url.startsWith("file:")) return { kind: "other" };
    const file = filePath(url);
    if (!file) return { kind: "other" };
    const n = norm(file);
    if (n.startsWith(this.normDist)) {
      if (!n.endsWith(".js") || !/[\\/]server[\\/]/.test(n.slice(this.normDist.length - 1)))
        return { kind: "framework" };
      const id = hmrModuleId(url);
      // Turbopack's own runtime chunk holds no module of the app.
      if (id === undefined)
        return /[\\/]\[turbopack\]_runtime\.js$/.test(n) ? { kind: "framework" } : { kind: "chunk", file };
      const rest = projectRest(id);
      if (!rest || /(^|\/)node_modules\//.test(rest)) return { kind: "framework" };
      return { kind: "hmr" };
    }
    return this.isProjectFile(file) ? { kind: "file", file } : { kind: "framework" };
  }

  startTake(): void {
    this.tally = {};
  }

  keep(url: string, script: ScriptCoverage): boolean {
    const id = script.scriptId;
    let e = this.book.get(id);
    if (!e || e.url !== url) {
      const c = this.classify(url);
      e = { kind: c.kind, url, seenAt: this.now(), file: c.file };
      if (this.book.size >= BOOK_MAX) this.book.clear();
      this.book.set(id, e);
    }
    if (e.kind === "chunk" && e.project === undefined) {
      // Once per script id: a chunk with no project module (Next's own, webpack-runtime) is framework.
      const ch = e.file ? this.chunk(e.file) : undefined;
      e.project = ch?.project !== false;
      if (!e.project) e.kind = "framework";
    }
    if (e.len === undefined && KEPT.has(e.kind)) e.len = topLength(script);
    this.tally[e.kind] = (this.tally[e.kind] ?? 0) + 1;
    return KEPT.has(e.kind);
  }

  /** The absolute path of a Turbopack `[project]/<rest>`: the one ancestor of the root it exists under. */
  private restPath(rest: string): string | undefined {
    const hit = this.rests.get(rest);
    if (hit !== undefined) return hit ?? undefined;
    const found: string[] = [];
    for (let dir = this.root; ; dir = path.dirname(dir)) {
      const abs = path.join(dir, rest);
      if (this.isProjectFile(abs) && this.fs.exists(abs)) found.push(abs);
      if (path.dirname(dir) === dir) break;
    }
    const out = found.length === 1 ? found[0]! : null;
    if (this.rests.size > 5000) this.rests.clear();
    this.rests.set(rest, out);
    return out ?? undefined;
  }

  /** An absolute path for a map source (file://, turbopack:///[project]/, absolute, webpack://..././). */
  private sourcePath(src: string): string | undefined {
    if (src.startsWith("file:")) return filePath(src);
    const tp = /^turbopack:\/\/\/(\[project\]\/.*)$/.exec(src);
    if (tp) {
      const rest = projectRest(tp[1]!);
      return rest ? this.restPath(rest) : undefined;
    }
    const wp = /^webpack(?:-internal)?:\/\/\/?(?:\([^)]*\)\/)?(?:[^/]*\/)?\.\/(.*)$/.exec(src);
    if (wp) return path.join(this.root, wp[1]!);
    if (path.isAbsolute(src) || /^[a-zA-Z]:[\\/]/.test(src)) return path.resolve(src);
    return undefined;
  }

  /** A map with every source made absolute (or null when unknown), for srcmap.ts buildIndex. */
  private absMap(m: RawMap): RawMap {
    if (m.sections) return { ...m, sections: m.sections.map((s) => ({ offset: s.offset, map: this.absMap(s.map) })) };
    return {
      ...m,
      sourceRoot: undefined,
      sources: (m.sources ?? []).map((s) => (typeof s === "string" ? (this.sourcePath(s) ?? null) : null)),
    };
  }

  /**
   * A chunk's text and project sections, read once per (mtime, size). A failure that can pass (the
   * file or its map unreadable, the map half written) is not cached: the next resolve retries it.
   */
  private chunk(file: string): Chunk | undefined {
    const st = this.fs.stat(file);
    if (!st) return undefined;
    const hit = this.chunks.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const out: Chunk = { mtimeMs: st.mtimeMs, size: st.size };
    const cache = () => {
      this.chunks.set(file, out);
      if (this.chunks.size > 2000) this.chunks.delete(this.chunks.keys().next().value as string);
      return out;
    };
    const name = path.basename(file);
    if (st.size > TEXT_MAX) {
      out.skip = `${name} is ${(st.size / 1024 / 1024).toFixed(1)} MB, over 4 MB, so Hoplens does not read it`;
      return cache();
    }
    this.reads++;
    const text = this.fs.readFile(file);
    if (text === undefined) {
      out.skip = `${name} could not be read`;
      return out;
    }
    // Module ids of project files, before reading any map: vendor chunks hold none. Next 16 lists
    // them as array items (`"<id>",`); the object form (`"<id>": (ctx) => {`) is accepted too.
    const files = new Set<string>();
    for (const m of text.matchAll(/^"(\[project\]\/[^"\n]+)"\s*[:,]/gm)) {
      const rest = projectRest(m[1]!);
      if (!rest || /(^|\/)node_modules\//.test(rest)) continue;
      out.project = true;
      const abs = this.restPath(rest);
      if (abs) files.add(abs);
    }
    if (!out.project) {
      out.project = false;
      return cache();
    }
    out.files = [...files];
    const urls = [...text.matchAll(/\/\/[#@][ \t]+sourceMappingURL=([^\s'"]+)[ \t]*(?:\r?\n|$)/g)];
    const last = urls[urls.length - 1]?.[1];
    if (!last || last.startsWith("data:")) {
      out.skip = `${name} names no sidecar source map`;
      return cache();
    }
    let mapFile: string;
    try {
      mapFile = path.resolve(path.dirname(file), decodeURIComponent(last));
    } catch {
      out.skip = `${name}'s sourceMappingURL does not decode`;
      return cache();
    }
    this.reads++;
    const mapText = this.fs.readFile(mapFile);
    if (mapText === undefined) {
      out.skip = `${name}'s map ${path.basename(mapFile)} could not be read (missing, or locked while the bundler writes it)`;
      return out;
    }
    let raw: RawMap;
    try {
      raw = JSON.parse(mapText) as RawMap;
    } catch {
      out.skip = `${name}'s map ${path.basename(mapFile)} is not valid JSON (half written?)`;
      return out;
    }
    const starts = lineStarts(text);
    if (!starts) {
      out.skip = `${name} has a line terminator other than \\n or \\r\\n (tools disagree on lines)`;
      return cache();
    }
    const sections: Section[] = [];
    const list = raw.sections ?? [{ offset: { line: 0, column: 0 }, map: raw }];
    const offsets = list.map((s) => {
      const ls = starts[s.offset.line];
      return ls === undefined ? -1 : ls + s.offset.column;
    });
    const tail = text.lastIndexOf("//# sourceMappingURL=");
    list.forEach((s, i) => {
      const start = offsets[i]!;
      if (start < 0) return;
      const next = offsets.slice(i + 1).find((o) => o >= 0);
      const end = next ?? (tail > start ? tail : text.length);
      const m = this.absMap(s.map);
      (m.sources ?? []).forEach((src, j) => {
        if (typeof src !== "string" || !this.isProjectFile(src)) return;
        sections.push({
          abs: src,
          start,
          end,
          map: m,
          content: typeof s.map.sourcesContent?.[j] === "string",
        });
      });
    });
    out.text = text;
    out.sections = sections;
    out.mapId = `${file}:${st.mtimeMs}:${st.size}`;
    return cache();
  }

  /** Project eval literals of webpack bundles (url -> distinct texts with their bundle files). */
  private evalTexts(): Map<string, Array<{ text: string; file: string; mtimeMs: number }>> {
    const out = new Map<string, Array<{ text: string; file: string; mtimeMs: number }>>();
    const dirs = [path.join(this.distDir, "dev", "server"), path.join(this.distDir, "server")];
    for (const dir of dirs) {
      for (const file of this.fs.jsFiles(dir)) {
        const st = this.fs.stat(file);
        if (!st) continue;
        let b = this.bundles.get(file);
        if (!b || b.mtimeMs !== st.mtimeMs || b.size !== st.size) {
          b = { mtimeMs: st.mtimeMs, size: st.size, evals: new Map() };
          this.bundles.set(file, b);
          this.reads++;
          const text = this.fs.readFile(file) ?? "";
          if (text.includes("sourceURL=webpack-internal:///")) {
            for (const m of text.matchAll(/\\n\/\/# sourceURL=(webpack-internal:\/\/\/[^"\\]+)\\n"\)/g)) {
              const url = m[1]!;
              if (this.classify(url).kind !== "webpack") continue;
              const close = m.index! + m[0].length - 2; // the closing quote
              const open = text.lastIndexOf('("', m.index);
              if (open < 0 || !/(?:\beval|\.ts)$/.test(text.slice(Math.max(0, open - 8), open))) continue;
              try {
                const v = JSON.parse(text.slice(open + 1, close + 1));
                if (typeof v === "string") b.evals.set(url, v);
              } catch {
                /* not a plain string literal */
              }
            }
          }
        }
        for (const [url, t] of b.evals) {
          const list = out.get(url) ?? [];
          list.push({ text: t, file, mtimeMs: b.mtimeMs });
          out.set(url, list);
        }
      }
    }
    return out;
  }

  resolve(scripts: readonly ScriptCoverage[], opts: { debuggerSource?: boolean } = {}): ResolvedScripts {
    const t0 = performance.now();
    const reads0 = this.reads;
    const warnings: string[] = [];
    const counts: ScriptCounts = { kinds: { ...this.tally }, holding: 0, files: 0, reads: 0, ms: 0 };
    let out: ResolvedScripts;
    try {
      out = this.resolveIn(scripts, opts, warnings, counts);
    } catch (err) {
      warnings.push(`resolving the bundled scripts failed: ${err instanceof Error ? err.message : String(err)}`);
      out = { scriptFor: () => undefined, lookup: () => undefined, counts, warnings };
    }
    counts.reads = this.reads - reads0;
    counts.ms = Math.round((performance.now() - t0) * 10) / 10;
    return out;
  }

  private resolveIn(
    scripts: readonly ScriptCoverage[],
    opts: { debuggerSource?: boolean },
    warnings: string[],
    counts: ScriptCounts,
  ): ResolvedScripts {
    /** One candidate script for one file. */
    interface Cand {
      s: ScriptCoverage;
      seen: Seen;
      abs: string;
      /** The text V8 ran, when certain. */
      text?: string;
      via?: "bundle" | "debugger";
      /** Its map (sources absolute), and the span of the file's code in `text`. */
      map?: RawMap;
      mapId?: string;
      span?: [number, number];
      content?: boolean;
      /** Why no text: the UNKNOWN detail, and its reason. */
      missing?: string;
      why?: MissingWhy;
      /** A rewritten chunk's section and chunk, re-anchored on V8's text by the Debugger read. */
      section?: Section;
      chunk?: Chunk;
    }
    const byFile = new Map<string, Cand[]>();
    const add = (c: Cand) => {
      const k = norm(c.abs);
      const list = byFile.get(k);
      if (list) list.push(c);
      else byFile.set(k, [c]);
    };
    const hint = "HOPLENS_PATH_DEBUGGER=1 reads it from V8 instead";
    const debuggerWanted: Cand[] = [];
    let debuggerMs: number | undefined;
    let evals: ReturnType<BundledScripts["evalTexts"]> | undefined;
    /** Chunks whose project files are not known (not read): why, for any file no script holds. */
    const unread: string[] = [];
    const warned = new Set<string>();

    for (const s of scripts) {
      const seen = this.book.get(s.scriptId);
      if (!seen || !KEPT.has(seen.kind)) continue;
      const len = seen.len ?? topLength(s);
      if (seen.kind === "file") {
        // Node ran the file itself: identity (capture.ts reads the file as for Express).
        add({ s, seen, abs: seen.file! });
        continue;
      }
      if (seen.kind === "webpack") {
        const c: Cand = { s, seen, abs: seen.file! };
        evals ??= this.evalTexts();
        const texts = (evals.get(s.url) ?? []).filter((x) => len === undefined || x.text.length === len);
        const fresh = texts.filter((x) => x.mtimeMs <= seen.seenAt);
        const distinct = [...new Set(fresh.map((x) => x.text))];
        if (distinct.length === 1) {
          c.text = distinct[0]!;
          c.via = "bundle";
        } else {
          c.why = distinct.length > 1 ? "no-generated-text" : "stale-chunk";
          c.missing =
            distinct.length > 1
              ? `the webpack bundles hold ${distinct.length} different texts for ${s.url}, and V8 does not say which one it ran; ${hint}`
              : `webpack re-emitted ${s.url} after V8 loaded it (or no bundle holds it any more), so the text V8 ran is not on disk; ${hint}`;
          debuggerWanted.push(c);
        }
        add(c);
        continue;
      }
      if (seen.kind === "hmr") {
        const rest = projectRest(hmrModuleId(s.url) ?? "");
        const abs = rest ? this.restPath(rest) : undefined;
        if (!abs) continue;
        const c: Cand = {
          s,
          seen,
          abs,
          why: "stale-chunk",
          missing: `Turbopack re-ran this module after an edit as a script whose text is only in V8 (not on disk); ${hint}, or restart next dev`,
        };
        debuggerWanted.push(c);
        add(c);
        continue;
      }
      // A Turbopack chunk: every project module in it.
      const file = seen.file!;
      const ch = this.chunk(file);
      if (!ch) continue;
      if (ch.skip || !ch.sections || ch.text === undefined) {
        const why = ch.skip ?? `${path.basename(file)} could not be read`;
        if (!warned.has(why)) {
          warned.add(why);
          warnings.push(`${why}: its project functions are UNKNOWN (unmapped)`);
        }
        if (ch.files?.length) for (const abs of ch.files) add({ s, seen, abs, why: "unmapped", missing: why });
        else unread.push(why);
        continue;
      }
      // A project module the map has no section for: never joined by guess.
      for (const abs of ch.files ?? [])
        if (!ch.sections.some((x) => norm(x.abs) === norm(abs)))
          add({ s, seen, abs, why: "unmapped", missing: `${path.basename(file)}'s map has no section for this file` });
      const fresh = ch.mtimeMs <= seen.seenAt && (len === undefined || len === ch.text.length);
      for (const sec of ch.sections) {
        const c: Cand = { s, seen, abs: sec.abs, content: sec.content };
        if (fresh) {
          c.text = ch.text;
          c.via = "bundle";
          c.map = { version: 3, sections: [{ offset: offsetOf(ch.text, sec.start), map: sec.map }] };
          c.mapId = `${ch.mapId}:${sec.start}`;
          c.span = [sec.start, sec.end];
        } else {
          c.why = "stale-chunk";
          c.missing = `Turbopack rewrote ${path.basename(file)} after V8 loaded it (an edit), so the text V8 ran is not on disk; ${hint}, or restart next dev`;
          c.section = sec;
          c.chunk = ch;
          debuggerWanted.push(c);
        }
        add(c);
      }
    }

    // The opt-in Debugger read: the texts no file holds any more, after the final take.
    if (opts.debuggerSource && debuggerWanted.length) {
      const ids = [...new Set(debuggerWanted.map((c) => c.s.scriptId))];
      const d = this.debuggerRead(ids);
      debuggerMs = Math.round(d.ms * 10) / 10;
      if (d.error) warnings.push(`the Debugger read of generated sources failed: ${d.error}`);
      for (const c of debuggerWanted) {
        const text = d.sources.get(c.s.scriptId);
        if (text === undefined) continue;
        if (c.section && c.chunk?.text !== undefined) {
          // A rewritten chunk: its module's section applies where that module's text is found.
          const sec = c.section;
          const body = c.chunk.text.slice(sec.start, sec.end);
          const at = body.length ? text.indexOf(body) : -1;
          if (at < 0 || text.indexOf(body, at + 1) >= 0) {
            c.why = "stale-chunk";
            c.missing = `Turbopack rewrote ${path.basename(c.seen.file ?? "")} after V8 loaded it, and this module's code there is not the code V8 ran`;
            continue;
          }
          c.text = text;
          c.via = "debugger";
          c.map = { version: 3, sections: [{ offset: offsetOf(text, at), map: sec.map }] };
          c.mapId = `${c.chunk.mapId}:${sec.start}@${c.s.scriptId}:${at}`;
          c.span = [at, at + body.length];
          c.missing = undefined;
          continue;
        }
        const m = inlineMap(text);
        if (!m) {
          c.why = "unmapped";
          c.missing = "the script V8 ran has no inline source map";
          continue;
        }
        c.text = text;
        c.via = "debugger";
        c.map = this.absMap(m);
        c.mapId = `inline@${c.s.scriptId}`;
        c.content = hasContent(c.map, c.abs);
        c.missing = undefined;
      }
    }

    // Inline maps of webpack modules read from disk.
    for (const list of byFile.values())
      for (const c of list) {
        if (c.text === undefined || c.map) continue;
        if (c.seen.kind === "file") continue;
        const m = inlineMap(c.text);
        if (!m) {
          c.text = undefined;
          c.why = "unmapped";
          c.missing = "the module's text has no inline source map";
          continue;
        }
        c.map = this.absMap(m);
        c.mapId = `inline:${c.s.url}:${c.text.length}`;
        c.content = hasContent(c.map, c.abs);
      }

    const chosen = new Map<string, Cand | NoScript>();
    const ran = (c: Cand) =>
      c.s.functions.some((f) => {
        const r = f.ranges[0];
        if (!r || r.count <= 0) return false;
        if (f.functionName === "" && r.startOffset === 0) return false;
        return !c.span || (r.startOffset >= c.span[0] && r.startOffset < c.span[1]);
      });
    for (const [k, all] of byFile) {
      // Turbopack replaced the module with its HMR update: the chunk's copy of it is dead code.
      const hmr = all.filter((c) => c.seen.kind === "hmr");
      const list = hmr.length ? hmr : all;
      // Without a text a chunk's span is unknown: it is a candidate only when nothing else ran the file.
      const known = list.filter((c) => c.span || c.seen.kind !== "chunk");
      const running = known.filter(ran);
      if (running.length === 1) chosen.set(k, running[0]!);
      else if (running.length > 1) {
        const what = running.map((c) => describe(c.s.url)).join(", ");
        chosen.set(k, {
          why: "bundle-copies",
          detail: `its code ran in ${running.length} bundled copies in this capture (${what})`,
        });
        warnings.push(
          `${rel(this.root, list[0]!.abs)}: ran in ${running.length} bundled copies (${what}), so no copy is joined`,
        );
      } else {
        const newest = list.slice().sort((a, b) => Number(b.s.scriptId) - Number(a.s.scriptId))[0]!;
        chosen.set(k, newest);
      }
    }
    const holding = new Set<string>();
    for (const c of chosen.values()) if ("s" in c) holding.add(c.s.scriptId);
    counts.holding = holding.size;
    counts.files = chosen.size;

    const lookup: GeneratedLookup = (_url, abs, scriptId): ScriptText | undefined => {
      const c = chosen.get(norm(abs));
      if (!c || !("s" in c) || c.s.scriptId !== scriptId) return undefined;
      if (c.seen.kind === "file") return undefined;
      if (c.text === undefined || !c.map)
        return { missing: c.missing ?? "the text V8 ran is not at hand", why: c.why ?? "no-generated-text" };
      return { code: c.text, via: c.via ?? "bundle", map: c.map, mapId: c.mapId, verified: !!c.content };
    };
    return {
      scriptFor: (abs) => {
        const c = chosen.get(norm(abs));
        if (!c) {
          // A chunk not read may hold it: say so rather than let it read as a join mismatch.
          if (unread.length && this.isProjectFile(abs))
            return { why: "unmapped", detail: `a chunk that may hold it was not read (${unread.join("; ")})` };
          return undefined;
        }
        return "s" in c ? c.s : c;
      },
      lookup,
      counts,
      warnings,
      ...(debuggerMs === undefined ? {} : { debuggerMs }),
    };
  }
}

/** Line and column of an offset, as a source-map section offset. */
function offsetOf(text: string, off: number): { line: number; column: number } {
  let line = 0;
  let last = -1;
  for (let i = text.indexOf("\n"); i >= 0 && i < off; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, column: off - last - 1 };
}

/** The map (sources absolute) carries sourcesContent for `abs`. */
function hasContent(m: RawMap, abs: string): boolean {
  const want = norm(abs);
  if (m.sections) return m.sections.some((s) => hasContent(s.map, abs));
  return (m.sources ?? []).some(
    (s, i) => typeof s === "string" && norm(s) === want && typeof m.sourcesContent?.[i] === "string",
  );
}

const rel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

/** A short name for a script URL in messages. */
function describe(url: string): string {
  const wp = /^webpack-internal:\/\/\/(\([^)]*\))/.exec(url);
  if (wp) return `webpack ${wp[1]}`;
  if (url.includes("?id=")) return "a Turbopack HMR update";
  return `chunk ${path.basename(url.replace(/[?#].*$/, ""))}`;
}

/** The bundled-script view for a Next app (RuntimeConfig.path.scripts). */
export function bundledScripts(opts: BundledOptions): PathScripts {
  return new BundledScripts(opts);
}
