// Content-hash cache of transform results, so a warm restart (node --watch, tsx watch, nodemon) loads no
// TypeScript in either thread: the ESM hook (hooks worker) and the CommonJS layer (main thread) each
// look a file up here before they call the pure transform (transformSource / transformCompiled /
// transformCommonJS, the only calls that load TypeScript), and store what it returned after a miss.
//
// One file per entry, `<dir>/<key>.hlc` (not `.json`: nodemon restarts on `.json` writes, and a stateDir
// may sit in the watched tree; same rule as sources.manifest), key = sha1 over: the entry schema, the transform version (sha1
// of the dist/index.js that computes the results, plus the TypeScript package it would load), the mode
// (raw / compiled / cjs), the root, the file's path relative to it, the preset, the include / exclude
// globs, sha1 of the source bytes the transform gets and, in COMPILED mode, sha1 of the raw file on
// disk. Anything that could change the output changes the key, so an entry is only ever read back for
// the same input, options and transform. An entry repeats its key (a renamed or truncated file is a
// miss) and stores the result as edits, not text: the same-length `const` -> `let  ` swaps (each one
// checked against the source again on a hit) and the text appended at EOF. A result whose output is not
// that shape is not stored.
//
// Written atomically (a temp file, then a rename; both threads may write the same entry, with the same
// bytes), read synchronously; any unreadable, corrupt or mismatched entry is a miss. A `none` is stored
// only when the parse ran (TypeScript loaded), or a start where TypeScript failed to load would leave
// the file unwrapped until its bytes change. Bounded: after the first write in a thread, an unref'd
// timer evicts the least recently used entries beyond MAX_ENTRIES or MAX_BYTES (a hit on an entry older
// than TOUCH_AFTER_MS moves its mtime, asynchronously). The scan is asynchronous (it never blocks the
// app's main thread) and runs at most once per EVICT_INTERVAL_MS for the dir (a stamp file), not after
// every edit restart in both threads. Off with HOPLENS_TRANSFORM_CACHE=0 (or no dir). Never throws.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { TransformOptions } from "./index";

/** Bumped whenever the entry format or the key's makeup changes. */
export const CACHE_SCHEMA = 1;
export const MAX_ENTRIES = 5000;
export const MAX_BYTES = 50 * 1024 * 1024;
/** Eviction trims to this share of the limits, so it does not run again on the next write. */
const TRIM_TO = 0.9;
/** A temp file older than this is a crashed write. */
const STALE_TMP_MS = 60_000;
const EVICT_DELAY_MS = 2000;
/** The eviction scan runs at most this often per cache dir. */
const EVICT_INTERVAL_MS = 10 * 60_000;
/** A hit refreshes an entry's mtime only when it is older than this (no write per hit). */
const TOUCH_AFTER_MS = 3600_000;
/** Entry files. */
export const ENTRY_EXT = ".hlc";
const STAMP = "evict.stamp";

/** Which transform call the result came from. */
export type CacheMode = "raw" | "compiled" | "cjs";

/** What the transform made of a file, as the loaders use it. */
export type CachedResult =
  | { kind: "wrapped"; code: string; fns: number }
  | { kind: "none" }
  | { kind: "refused"; reason: string };

interface Entry {
  v: number;
  key: string;
  kind: "wrapped" | "none" | "refused";
  fns?: number;
  swaps?: number[];
  suffix?: string;
  reason?: string;
}

const sha1 = (b: string | Buffer) => createHash("sha1").update(b).digest("hex");

/** HOPLENS_TRANSFORM_CACHE=0 / false / off. */
export function cacheDisabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.HOPLENS_TRANSFORM_CACHE?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

/**
 * The version part of the key: the transform build (dist/index.js next to the caller) and the
 * TypeScript it loads (resolved and its package.json read; TypeScript itself is not loaded).
 * Undefined when index.js cannot be read: no cache then.
 */
export function transformVersion(distDir: string, root: string): string | undefined {
  let index: Buffer;
  try {
    index = fs.readFileSync(path.join(distDir, "index.js"));
  } catch {
    return undefined;
  }
  let ts = "none";
  // Same order as loadTypeScript(): Hoplens' own TypeScript, then the project's.
  for (const base of [distDir, root]) {
    try {
      const pj = createRequire(path.join(base, "package.json")).resolve("typescript/package.json");
      const version = JSON.parse(fs.readFileSync(pj, "utf8"))?.version;
      ts = `${pj}@${String(version)}`;
      break;
    } catch {
      /* try next */
    }
  }
  return sha1(`${sha1(index)}\0${ts}`);
}

/** Where this source's result lives: the key covers everything the result depends on. */
export function cacheKey(
  version: string,
  mode: CacheMode,
  file: string,
  source: string | Buffer,
  opts: TransformOptions,
  raw?: string | Buffer,
): string {
  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  return sha1(
    JSON.stringify([
      CACHE_SCHEMA,
      version,
      mode,
      opts.root,
      rel,
      opts.preset ?? "next",
      opts.include ?? null,
      opts.exclude ?? null,
      sha1(source),
      raw === undefined ? null : sha1(raw),
    ]),
  );
}

/**
 * The result as edits against `src`: `const` -> `let  ` swaps, then appended text. Undefined when the
 * output is not that shape (it is then not cached).
 */
export function toEdits(src: string, code: string): { swaps: number[]; suffix: string } | undefined {
  if (code.length < src.length) return undefined;
  const swaps: number[] = [];
  for (let i = 0; i < src.length; i++) {
    if (code.charCodeAt(i) === src.charCodeAt(i)) continue;
    if (src.startsWith("const", i) && code.startsWith("let  ", i)) {
      swaps.push(i);
      i += 4;
      continue;
    }
    return undefined;
  }
  return { swaps, suffix: code.slice(src.length) };
}

/** `src` with the edits applied; undefined when a swap does not land on `const`. */
export function fromEdits(src: string, swaps: number[], suffix: string): string | undefined {
  let out = src;
  let last = -5;
  for (const s of swaps) {
    if (!Number.isInteger(s) || s < last + 5 || !src.startsWith("const", s)) return undefined;
    out = `${out.slice(0, s)}let  ${out.slice(s + 5)}`;
    last = s;
  }
  return out + suffix;
}

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
}

export class TransformCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0 };
  private evictTimer: NodeJS.Timeout | undefined;
  private evicted = false;
  constructor(
    readonly dir: string,
    readonly version: string,
    readonly limits = { entries: MAX_ENTRIES, bytes: MAX_BYTES },
  ) {}

  /** The stored result for `key`, rebuilt against `src`; undefined on a miss. Never throws. */
  get(key: string, src: string): CachedResult | undefined {
    try {
      const p = path.join(this.dir, `${key}${ENTRY_EXT}`);
      const fd = fs.openSync(p, "r");
      let text: string;
      let mtime: number;
      try {
        mtime = fs.fstatSync(fd).mtimeMs;
        text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      const r = this.decode(JSON.parse(text) as Entry, key, src);
      if (r) {
        this.stats.hits++;
        // Least recently used: an entry in use outlives one written later for bytes no longer on disk.
        if (Date.now() - mtime > TOUCH_AFTER_MS) {
          const now = new Date();
          fs.utimes(p, now, now, () => {});
        }
        return r;
      }
    } catch {
      /* absent, unreadable or corrupt: a miss */
    }
    this.stats.misses++;
    return undefined;
  }

  private decode(e: Entry, key: string, src: string): CachedResult | undefined {
    if (!e || typeof e !== "object" || e.v !== CACHE_SCHEMA || e.key !== key) return undefined;
    if (e.kind === "none") return { kind: "none" };
    if (e.kind === "refused") return typeof e.reason === "string" ? { kind: "refused", reason: e.reason } : undefined;
    if (e.kind !== "wrapped") return undefined;
    if (!Array.isArray(e.swaps) || typeof e.suffix !== "string" || !Number.isInteger(e.fns) || e.fns! < 1) {
      return undefined;
    }
    const code = fromEdits(src, e.swaps, e.suffix);
    return code === undefined ? undefined : { kind: "wrapped", code, fns: e.fns! };
  }

  /** Store `r` for `key` (computed from `src`). Never throws; a result it cannot express is skipped. */
  set(key: string, src: string, r: CachedResult): void {
    try {
      let e: Entry;
      if (r.kind === "wrapped") {
        const edits = toEdits(src, r.code);
        if (!edits) return;
        e = { v: CACHE_SCHEMA, key, kind: "wrapped", fns: r.fns, swaps: edits.swaps, suffix: edits.suffix };
      } else if (r.kind === "refused") e = { v: CACHE_SCHEMA, key, kind: "refused", reason: r.reason };
      else e = { v: CACHE_SCHEMA, key, kind: "none" };
      fs.mkdirSync(this.dir, { recursive: true });
      const target = path.join(this.dir, `${key}${ENTRY_EXT}`);
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(e));
        fs.renameSync(tmp, target);
        this.stats.writes++;
      } catch {
        // Windows: the other thread may hold the target open; its entry has the same bytes.
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best effort */
        }
        return;
      }
      this.scheduleEvict();
    } catch {
      /* the next start computes it again */
    }
  }

  private scheduleEvict(): void {
    if (this.evicted || this.evictTimer) return;
    this.evictTimer = setTimeout(() => {
      this.evicted = true;
      if (evictDue(this.dir)) void evictCache(this.dir, this.limits);
    }, EVICT_DELAY_MS);
    this.evictTimer.unref?.();
  }
}

/**
 * Whether the eviction scan is due for `dir` (none ran there, in any thread or process, in the last
 * EVICT_INTERVAL_MS); when it is, the stamp is moved so the next caller skips. Never throws.
 */
export function evictDue(dir: string, now = Date.now()): boolean {
  const stamp = path.join(dir, STAMP);
  try {
    const last = fs.statSync(stamp).mtimeMs;
    if (now - last < EVICT_INTERVAL_MS && last <= now + 1000) return false;
  } catch {
    /* never ran */
  }
  try {
    fs.writeFileSync(stamp, "");
    const t = new Date(now);
    fs.utimesSync(stamp, t, t);
  } catch {
    /* scan anyway: it is bounded */
  }
  return true;
}

/**
 * Delete the least recently used entries while the dir holds more than `limits` (down to 90% of them),
 * and temp files a crashed write left behind. Asynchronous, one stat at a time (it never blocks the
 * thread, nor holds more than one libuv worker). Resolves how many entries it deleted. Never rejects.
 */
export async function evictCache(
  dir: string,
  limits: { entries: number; bytes: number } = { entries: MAX_ENTRIES, bytes: MAX_BYTES },
  now = Date.now(),
): Promise<number> {
  const fsp = fs.promises;
  let deleted = 0;
  try {
    const files: { p: string; size: number; mtime: number }[] = [];
    let bytes = 0;
    for (const name of await fsp.readdir(dir)) {
      const tmp = name.endsWith(".tmp");
      if (!tmp && !name.endsWith(ENTRY_EXT)) continue;
      const p = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (tmp) {
        if (now - st.mtimeMs > STALE_TMP_MS) await fsp.rm(p, { force: true }).catch(() => {});
        continue;
      }
      files.push({ p, size: st.size, mtime: st.mtimeMs });
      bytes += st.size;
    }
    if (files.length <= limits.entries && bytes <= limits.bytes) return 0;
    files.sort((a, b) => a.mtime - b.mtime);
    let count = files.length;
    for (const f of files) {
      if (count <= limits.entries * TRIM_TO && bytes <= limits.bytes * TRIM_TO) break;
      try {
        await fsp.rm(f.p, { force: true });
        deleted++;
      } catch {
        /* the other thread got it */
      }
      count--;
      bytes -= f.size;
    }
  } catch {
    /* no dir yet */
  }
  return deleted;
}

/** The entries in `dir` and their total size (for doctor and tests). */
export function cacheSize(dir: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(ENTRY_EXT)) continue;
      try {
        bytes += fs.statSync(path.join(dir, name)).size;
        entries++;
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* no dir */
  }
  return { entries, bytes };
}

/** A cache in `dir` for the transform build in `distDir`, or undefined when it is off. Never throws. */
export function openCache(dir: string | undefined, distDir: string, root: string): TransformCache | undefined {
  try {
    if (!dir || cacheDisabledByEnv()) return undefined;
    const version = transformVersion(distDir, root);
    return version ? new TransformCache(dir, version) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Look the result up, else compute it (`compute` may load TypeScript) and store it. `hit` is undefined
 * when there is no cache. Exceptions from `compute` propagate (nothing is stored for them). `parsed`
 * (TypeScript is loaded in this thread) gates storing a `none`: the transform also answers none when
 * TypeScript failed to load, and that must not outlive this start.
 */
export function cached(
  cache: TransformCache | undefined,
  mode: CacheMode,
  file: string,
  src: string,
  opts: TransformOptions,
  compute: () => CachedResult,
  raw?: string | Buffer,
  parsed?: () => boolean,
): { result: CachedResult; hit?: boolean } {
  if (!cache) return { result: compute() };
  let key: string | undefined;
  try {
    key = cacheKey(cache.version, mode, file, src, opts, raw);
  } catch {
    return { result: compute() };
  }
  const got = cache.get(key, src);
  if (got) return { result: got, hit: true };
  const result = compute();
  let store = true;
  if (result.kind === "none" && parsed) {
    try {
      store = parsed();
    } catch {
      store = false;
    }
  }
  if (store) cache.set(key, src, result);
  return { result, hit: false };
}
