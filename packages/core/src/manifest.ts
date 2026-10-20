// Edits across process restarts (`RuntimeConfig.epochs.mode: "restart"`).
//
// `node --watch`, `tsx watch` and nodemon restart the whole process on every save, so there is no
// in-process rebuild to watch. Instead each process hashes the project's source files at start and
// compares them with the manifest the previous process left in the persist dir: a file whose
// normalized content changed (or that was added or deleted) makes this process a new epoch,
// `via: "restart"`, naming those files. A restart where nothing changed (a `touch`, a formatter-only
// save, a manual restart) continues the previous epoch.
//
// "Normalized" is token-level (lesson 16 for raw source): JS, TS and JSON are scanned with the
// TypeScript scanner with trivia skipped, so whitespace, line breaks and comments never count, nor do
// quote style, semicolons or trailing commas (what Prettier and Biome change on save). Other source
// files (.sql, .graphql, .prisma) count with runs of whitespace collapsed. Without a TypeScript to
// load, every byte counts (`norm: "raw"`).
//
// Cost: once per process start, never per request. A file whose size and mtime match the manifest
// costs one stat; a touched file one read and one sha1 (the raw hash matches, so its normalized hash
// is reused); TypeScript is loaded only when some file's bytes changed, and only those files are read
// again to be scanned. Files over 1MB are hashed in pieces, never held whole. The manifest is written
// to a temp file and renamed over the old one, so a watcher's SIGKILL mid-write leaves either the old
// manifest or the new one, never a torn file. Its name is not `.json`: nodemon restarts on a `.json`
// change, so a state dir outside node_modules would restart the app in a loop.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ImportGraph } from "./importgraph";
import { SKIP_SEGMENTS, isSourceFile, sourceDirs } from "./sourcewatch";

export const MANIFEST_FILE = "sources.manifest";
export const MANIFEST_VERSION = 1;
/** Files hashed per start; past this the walk stops (in a stable order, so the cut is the same each time). */
export const MAX_MANIFEST_FILES = 5000;
/** Files larger than this are hashed as raw bytes (no normalization), read in pieces. */
const MAX_NORMALIZE_BYTES = 1024 * 1024;
/** A file modified this close to the build keeps no stat: a rewrite in the same tick would look unchanged. */
const RACY_MS = 2000;
/** Tokens scanned per file before the rest is hashed as raw text. */
const MAX_TOKENS = 2_000_000;

/** How the `norm` hashes of a manifest were made; two manifests compare by norm only when these match. */
export type NormKind = "ts1" | "raw";

export interface SourceManifest {
  v: typeof MANIFEST_VERSION;
  norm: NormKind;
  /** Wall-clock ms it was built. */
  at: number;
  /**
   * Project-relative path (`/` separators) -> [raw sha1, normalized sha1, mtimeMs, size]. The stat is
   * left out for a file modified just before the build (it is read again next time).
   */
  files: Record<string, FileHashes>;
  /** The walk stopped at the file cap: files past it are not listed (and not deleted). */
  truncated?: boolean;
}

export type FileHashes = [string, string] | [string, string, number, number];

export interface ManifestDiff {
  /** Files whose normalized content changed. */
  changed: string[];
  added: string[];
  deleted: string[];
}

/** The `typescript` module, or the part of it the normalizer uses. */
export type TypeScriptLike = any;

const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("base64");

const SCANNED_EXT = /\.(?:[cm]?[jt]sx?|json)$/i;
const JSX_EXT = /\.[jt]sx$/i;
/** The token a statement end (an explicit `;` or one ASI inserts at a line break) stands for. */
const END = ";";

interface Kinds {
  division: Set<number>;
  /** A line break after one of these ends the statement (return / throw / break / continue / yield). */
  restricted: Set<number>;
  /** Tokens that can end a statement ... */
  ends: Set<number>;
  /** ... and keywords that go on one (`} else`, `a instanceof b`) rather than start the next. */
  continuing: Set<number>;
  k: Record<string, number>;
}

let kinds: Kinds | undefined;
let kindsOf: unknown;

function tokenKinds(ts: TypeScriptLike) {
  if (kinds && kindsOf === ts) return kinds;
  const K = ts.SyntaxKind as Record<string, number>;
  // A `/` after one of these is division; anywhere else it starts a regex. Unsure cases fall on the
  // regex side: a division read as a regex keeps its spaces (a formatter save counts, conservatively),
  // while a regex read as division would let a `//` inside it hide the rest of the line.
  const division = new Set(
    [
      "Identifier",
      "PrivateIdentifier",
      "NumericLiteral",
      "BigIntLiteral",
      "StringLiteral",
      "NoSubstitutionTemplateLiteral",
      "TemplateTail",
      "RegularExpressionLiteral",
      "CloseParenToken",
      "CloseBracketToken",
      "CloseBraceToken",
      "ThisKeyword",
      "SuperKeyword",
      "TrueKeyword",
      "FalseKeyword",
      "NullKeyword",
      "PlusPlusToken",
      "MinusMinusToken",
    ]
      .map((n) => K[n])
      .filter((n): n is number => typeof n === "number"),
  );
  const set = (names: string[]) => new Set(names.map((n) => K[n]).filter((n): n is number => typeof n === "number"));
  const restricted = set(["ReturnKeyword", "ThrowKeyword", "BreakKeyword", "ContinueKeyword", "YieldKeyword"]);
  const ends = new Set(division);
  for (let n = K.FirstKeyword!; n <= K.LastKeyword!; n++) if (!restricted.has(n)) ends.add(n);
  const continuing = set([
    "ElseKeyword",
    "CatchKeyword",
    "FinallyKeyword",
    "WhileKeyword",
    "InKeyword",
    "InstanceOfKeyword",
    "AsKeyword",
    "SatisfiesKeyword",
    "ExtendsKeyword",
    "ImplementsKeyword",
    "OfKeyword",
  ]);
  kinds = { division, restricted, ends, continuing, k: K };
  kindsOf = ts;
  return kinds;
}

/**
 * The token stream of a JS / TS / JSON text with trivia (whitespace, comments, a shebang) dropped,
 * string literals in one quote style and trailing commas left out. A statement end is one token
 * whether written as `;` or left to ASI at a line break, so a formatter adding or dropping semicolons
 * gives the same string, while a line break ASI reads differently (`return` then a new line, a
 * dropped `;` before a line starting with `(` or `[`) does not. With `jsx` (`.jsx` / `.tsx`) comments
 * count: this scanner does not know JSX text, where `//` is text (`<a>http://x</a>`). Pure; exported
 * for tests.
 */
export function sourceTokens(text: string, ts: TypeScriptLike, jsx = false): string {
  const { division, restricted, ends, continuing, k: K } = tokenKinds(ts);
  const sc = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const out: string[] = [];
  /** Open braces: true = a template literal's `${`. */
  const braces: boolean[] = [];
  let prev = -1;
  /** The last token, `;` included (what ASI looks at). */
  let last = -1;
  let newline = false;
  let n = 0;
  /** jsx: comment texts, kept apart (where a comment sits does not count, what it says does). */
  const comments: string[] = [];
  const end = () => {
    if (out.length && out[out.length - 1] !== END) out.push(END);
  };
  for (;;) {
    let kind: number = sc.scan();
    if (kind === K.EndOfFileToken) break;
    if (kind === K.NewLineTrivia) {
      newline = true;
      continue;
    }
    if (kind === K.WhitespaceTrivia || kind === K.ShebangTrivia) continue;
    if (kind === K.SingleLineCommentTrivia || kind === K.MultiLineCommentTrivia) {
      const t: string = sc.getTokenText();
      if (kind === K.MultiLineCommentTrivia && /[\r\n\u2028\u2029]/.test(t)) newline = true;
      if (jsx) comments.push(t.replace(/\s+/g, " ").trim());
      continue;
    }
    if (++n > MAX_TOKENS) {
      out.push(text.slice(sc.getTokenStart?.() ?? sc.getTokenPos?.() ?? 0));
      break;
    }
    const brokeLine = newline;
    newline = false;
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !division.has(prev)) kind = sc.reScanSlashToken();
    else if (kind === K.TemplateHead) braces.push(true);
    else if (kind === K.OpenBraceToken) braces.push(false);
    else if (kind === K.CloseBraceToken && braces.length) {
      if (braces.pop()) {
        kind = sc.reScanTemplateToken(false);
        if (kind === K.TemplateMiddle) braces.push(true);
      }
    }
    prev = kind;
    const before = last;
    last = kind;
    if (kind === K.SemicolonToken) {
      end();
      continue;
    }
    // ASI: a line break ends the statement after return & co., and between a token that can end one
    // and one that starts the next (not before `(`, `[`, `.` or an operator: those go on).
    if (
      brokeLine &&
      (restricted.has(before) ||
        (ends.has(before) &&
          (kind === K.Identifier ||
            kind === K.PrivateIdentifier ||
            kind === K.NumericLiteral ||
            kind === K.BigIntLiteral ||
            kind === K.StringLiteral ||
            kind === K.PlusPlusToken ||
            kind === K.MinusMinusToken ||
            (kind >= K.FirstKeyword! && kind <= K.LastKeyword! && !continuing.has(kind)))))
    )
      end();
    if (kind === K.CloseBraceToken && out[out.length - 1] === END) out.pop(); // `a; }` is `a }`
    if (
      (kind === K.CloseParenToken || kind === K.CloseBracketToken || kind === K.CloseBraceToken) &&
      out[out.length - 1] === ","
    )
      out.pop();
    out.push(kind === K.StringLiteral ? JSON.stringify(sc.getTokenValue()) : sc.getTokenText());
  }
  if (out[out.length - 1] === END) out.pop();
  if (comments.length) out.push("\u0001", ...comments);
  return out.join("\u0000");
}

/**
 * The text a file's normalized hash is taken over. `ts` undefined: JS / TS / JSON files are taken as
 * is. Pure; exported for tests.
 */
export function normalizeSource(text: string, file: string, ts?: TypeScriptLike): string {
  if (SCANNED_EXT.test(file)) return ts ? sourceTokens(text, ts, JSX_EXT.test(file)) : text;
  return text.replace(/\s+/g, " ").trim();
}

/** Compare two manifests (by normalized hash, or raw hash when they were normalized differently). */
export function diffManifests(prev: SourceManifest, next: SourceManifest): ManifestDiff {
  const which = prev.norm === next.norm ? 1 : 0;
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const [f, h] of Object.entries(next.files)) {
    const p = prev.files[f];
    if (!p) added.push(f);
    else if (p[which] !== h[which]) changed.push(f);
  }
  for (const f of Object.keys(prev.files)) if (!next.files[f]) deleted.push(f);
  return { changed: changed.sort(), added: added.sort(), deleted: deleted.sort() };
}

/** True when two manifests record the same files the same way (`at` aside): nothing to rewrite. */
export function sameFiles(a: SourceManifest, b: SourceManifest): boolean {
  if (a.norm !== b.norm || !a.truncated !== !b.truncated) return false;
  const ka = Object.keys(a.files);
  if (ka.length !== Object.keys(b.files).length) return false;
  for (const f of ka) {
    const x = a.files[f]!;
    const y = b.files[f];
    if (!y || x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
  }
  return true;
}

/** True when the diff has anything in it. */
export function isEdit(d: ManifestDiff): boolean {
  return d.changed.length + d.added.length + d.deleted.length > 0;
}

/** The manifest at `file`, or undefined when missing, unreadable or not one (a corrupt file is no manifest). */
export function readManifest(file: string): SourceManifest | undefined {
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const m = v as SourceManifest;
  if (!m || typeof m !== "object" || m.v !== MANIFEST_VERSION || (m.norm !== "ts1" && m.norm !== "raw"))
    return undefined;
  if (!m.files || typeof m.files !== "object" || Array.isArray(m.files)) return undefined;
  for (const h of Object.values(m.files)) {
    if (!Array.isArray(h) || typeof h[0] !== "string" || typeof h[1] !== "string") return undefined;
    if (h.length !== 2 && (h.length !== 4 || typeof h[2] !== "number" || typeof h[3] !== "number")) return undefined;
  }
  return m;
}

/**
 * Write the manifest atomically: a temp file next to it, then a rename over the old one (also on
 * Windows, where a rename onto a file someone has open can fail for a moment: retried briefly).
 * Never throws; false when it could not be written.
 */
export function writeManifest(file: string, m: SourceManifest): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(m));
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (i >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
        sleepSync(20);
      }
    }
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics.wait: retry at once */
  }
}

/** Remove temp files a killed process left behind (`sources.manifest.<pid>.tmp`). Never throws. */
export function sweepTempFiles(file: string): void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    for (const name of fs.readdirSync(dir))
      if (name.startsWith(`${base}.`) && name.endsWith(".tmp") && name !== `${base}.${process.pid}.tmp`)
        fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------ file selection */

/** `.gitignore`-ish rules: plain names (a segment anywhere), paths (a prefix) and `*.ext` suffixes. */
interface Ignore {
  names: Set<string>;
  prefixes: string[];
  suffixes: string[];
}

/** The simple rules of a `.gitignore` (negations and other globs are left out). Pure; exported for tests. */
export function parseIgnore(text: string): Ignore {
  const out: Ignore = { names: new Set(), prefixes: [], suffixes: [] };
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const anchored = line.startsWith("/");
    line = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!line) continue;
    const star = /^\*(\.[\w.-]+)$/.exec(line);
    if (star) out.suffixes.push(star[1]!.toLowerCase());
    else if (/[*?[\]\\]/.test(line)) continue;
    else if (anchored || line.includes("/")) out.prefixes.push(line);
    else out.names.add(line);
  }
  return out;
}

function ignored(rel: string, ig: Ignore, exclude: readonly string[]): boolean {
  for (const p of exclude) if (rel === p || rel.startsWith(`${p}/`)) return true;
  for (const p of ig.prefixes) if (rel === p || rel.startsWith(`${p}/`)) return true;
  const segs = rel.split("/");
  for (const s of segs) if (ig.names.has(s)) return true;
  const base = (segs[segs.length - 1] ?? "").toLowerCase();
  return ig.suffixes.some((s) => base.endsWith(s));
}

export interface ListSourceOptions {
  /** Project-relative dirs to walk. Default: the source watcher's (`src`, else the FALLBACK_DIRS present). */
  dirs?: string[];
  /** Project-relative paths never listed (the persist dir when it sits inside the project). */
  exclude?: string[];
  maxFiles?: number;
}

/**
 * The project's source files, project-relative with `/` separators, sorted: top-level files plus
 * every source file under the source dirs, the same selection the source watcher hashes, minus what
 * `.gitignore` names simply and `exclude`. Never throws.
 */
export function listSourceFiles(root: string, opts: ListSourceOptions = {}): string[] {
  return walkSourceFiles(root, opts).files;
}

/** listSourceFiles, and whether the walk stopped at the cap (`maxFiles`, default MAX_MANIFEST_FILES). */
export function walkSourceFiles(root: string, opts: ListSourceOptions = {}): { files: string[]; truncated: boolean } {
  const max = opts.maxFiles ?? MAX_MANIFEST_FILES;
  let truncated = false;
  let ig: Ignore = { names: new Set(), prefixes: [], suffixes: [] };
  try {
    ig = parseIgnore(fs.readFileSync(path.join(root, ".gitignore"), "utf8"));
  } catch {
    /* none */
  }
  const exclude = (opts.exclude ?? []).map((p) => p.replace(/\\/g, "/").replace(/^\.\/|\/+$/g, "")).filter(Boolean);
  const out: string[] = [];
  const entries = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return [];
    }
  };
  for (const e of entries("."))
    if (e.isFile() && isSourceFile(e.name) && !ignored(e.name, ig, exclude)) out.push(e.name);
  const walk = (dir: string) => {
    for (const e of entries(dir)) {
      if (out.length >= max) {
        truncated = true;
        return;
      }
      const rel = `${dir}/${e.name}`;
      if (ignored(rel, ig, exclude)) continue;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !SKIP_SEGMENTS.has(e.name)) walk(rel);
      } else if (e.isFile() && isSourceFile(rel)) out.push(rel);
    }
  };
  for (const d of (opts.dirs ?? sourceDirs(root)).map((d) => d.replace(/\\/g, "/").replace(/\/+$/, ""))) {
    if (out.length >= max) {
      truncated = true;
      break;
    }
    if (!ignored(d, ig, exclude)) walk(d);
  }
  if (out.length > max) truncated = true;
  return { files: out.slice(0, max).sort(), truncated };
}

/* ------------------------------------------------------------ build */

export interface BuildManifestOptions {
  /** Loads TypeScript, called at most once and only when some file's bytes changed. */
  typescript?: () => TypeScriptLike | null | undefined;
  clock?: () => number;
}

/** sha1 of a file read in pieces (never held whole). Throws when it cannot be read. */
function hashFile(file: string): string {
  const h = createHash("sha1");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("base64");
}

/**
 * Hash `files` (project-relative). A file whose size and mtime match `prev` is not read; one whose
 * raw hash matches keeps its normalized hash without being scanned; only files whose bytes changed
 * are read again to be normalized (no file is held in memory past its own hash). Unreadable files
 * are left out (they read as deleted). Never throws.
 */
export function buildManifest(
  root: string,
  files: readonly string[],
  prev?: SourceManifest,
  opts: BuildManifestOptions = {},
): SourceManifest {
  const at = (opts.clock ?? Date.now)();
  /** Per file: its raw hash and stat, and the previous normalized hash when the bytes are the same. */
  const seen: Array<{ f: string; hash: string; mtimeMs: number; size: number; same?: string }> = [];
  for (const f of files) {
    const abs = path.join(root, f);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      const old = prev?.files[f];
      if (old && old.length === 4 && old[2] === st.mtimeMs && old[3] === st.size) {
        seen.push({ f, hash: old[0], mtimeMs: st.mtimeMs, size: st.size, same: old[1] });
        continue;
      }
      const hash = st.size > MAX_NORMALIZE_BYTES ? hashFile(abs) : sha1(fs.readFileSync(abs));
      seen.push({ f, hash, mtimeMs: st.mtimeMs, size: st.size, same: old && old[0] === hash ? old[1] : undefined });
    } catch {
      /* gone or unreadable */
    }
  }
  const needs = seen.filter((r) => r.same === undefined);
  let norm: NormKind = prev?.norm ?? "ts1";
  let ts: TypeScriptLike | undefined;
  if (needs.length && needs.some((r) => SCANNED_EXT.test(r.f))) {
    try {
      ts = opts.typescript?.() ?? undefined;
    } catch {
      ts = undefined;
    }
    if (!ts || typeof ts.createScanner !== "function") ts = undefined;
    norm = ts ? "ts1" : "raw";
  } else if (needs.length && !prev) norm = "ts1"; // only non-JS files: whitespace collapse needs no TypeScript
  const reuse = prev !== undefined && prev.norm === norm;
  const out: SourceManifest = { v: MANIFEST_VERSION, norm, at, files: {} };
  for (const r of seen) {
    let h = r.hash;
    if (reuse && r.same !== undefined) h = r.same;
    else if (r.size <= MAX_NORMALIZE_BYTES && !(norm === "raw" && SCANNED_EXT.test(r.f))) {
      try {
        const buf = fs.readFileSync(path.join(root, r.f));
        // Changed again since it was hashed: take the bytes read now for both hashes.
        const raw = sha1(buf);
        r.hash = raw;
        h = sha1(normalizeSource(buf.toString("utf8"), r.f, ts));
      } catch {
        h = r.hash;
      }
    }
    out.files[r.f] = r.mtimeMs < at - RACY_MS ? [r.hash, h, r.mtimeMs, r.size] : [r.hash, h];
  }
  return out;
}

/* ------------------------------------------------------------ the start-time check */

export interface RestartCheck {
  /** The previous process's manifest (undefined: first run, or it was missing / corrupt). */
  prev?: SourceManifest;
  next: SourceManifest;
  /** Set when there was a manifest to compare with. */
  diff?: ManifestDiff;
  /** Wall-clock ms of the newest changed or added file (0 when none). */
  newestMtime: number;
  /** The walk stopped at MAX_MANIFEST_FILES: edits past the cut are not seen. */
  truncated: boolean;
}

export interface RestartCheckOptions extends BuildManifestOptions, ListSourceOptions {}

/** Hash the project and compare with the manifest in `dir`. Does not write. Never throws. */
export function checkRestart(root: string, dir: string, opts: RestartCheckOptions = {}): RestartCheck {
  const file = path.join(dir, MANIFEST_FILE);
  const prev = readManifest(file);
  const rel = path.relative(root, dir).replace(/\\/g, "/");
  const exclude = [...(opts.exclude ?? [])];
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) exclude.push(rel);
  const { files, truncated } = walkSourceFiles(root, { dirs: opts.dirs, exclude, maxFiles: opts.maxFiles });
  const next = buildManifest(root, files, prev, opts);
  if (truncated) next.truncated = true;
  let diff = prev ? diffManifests(prev, next) : undefined;
  if (diff && prev) diff = dropNoise(root, prev, next, diff, files);
  let newestMtime = 0;
  for (const f of diff ? [...diff.changed, ...diff.added] : []) {
    try {
      newestMtime = Math.max(newestMtime, fs.statSync(path.join(root, f)).mtimeMs);
    } catch {
      /* gone again */
    }
  }
  return { prev, next, diff, newestMtime: Math.round(newestMtime), truncated };
}

const DATA_EXT = /\.json$/i;
/** JSON that changes how the project builds or runs without any module importing it. */
const CONFIG_JSON = /^(?:package|[jt]sconfig(?:\.[\w.-]+)?)\.json$/i;

/** True for a `.json` that only counts as an edit when some module imports it. Exported for tests. */
export function isDataJson(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return DATA_EXT.test(base) && !CONFIG_JSON.test(base);
}

/**
 * Leave out of a diff what is not an edit: a file "deleted" only because a capped walk no longer
 * reached it (it is still on disk), and a `.json` that no module imports and that was written after
 * the previous process started, wherever it sits (a store or dump the app writes itself, lowdb-style,
 * or a `path.json` saved into the project root). `package.json` and `tsconfig*.json` /
 * `jsconfig*.json` always count. Never throws.
 */
function dropNoise(
  root: string,
  prev: SourceManifest,
  next: SourceManifest,
  diff: ManifestDiff,
  files: readonly string[],
): ManifestDiff {
  let { changed, added, deleted } = diff;
  if (next.truncated || prev.truncated)
    deleted = deleted.filter((f) => {
      try {
        fs.statSync(path.join(root, f));
        return false;
      } catch {
        return true;
      }
    });
  const data = [...changed, ...added].filter(isDataJson);
  if (data.length) {
    const fresh = data.filter((f) => {
      const h = next.files[f];
      let mtime = h && h.length === 4 ? h[2] : undefined;
      if (mtime === undefined) {
        try {
          mtime = fs.statSync(path.join(root, f)).mtimeMs;
        } catch {
          return false;
        }
      }
      return mtime > prev.at;
    });
    if (fresh.length) {
      const code = files.filter((f) => /\.[cm]?[jt]sx?$/i.test(f));
      const graph = new ImportGraph(root);
      const noise = new Set(fresh.filter((f) => !graph.isImported(f, code)));
      if (noise.size) {
        changed = changed.filter((f) => !noise.has(f));
        added = added.filter((f) => !noise.has(f));
      }
    }
  }
  return { changed, added, deleted };
}

/** Where the manifest lives in a persist dir. */
export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_FILE);
}
