// Source-file attribution for dev-rebuild epochs (plan 3.5 / WP9a).
//
// The rebuild signal stays the built-chunk detector in epoch.ts; this watcher only answers "which of
// the user's files changed since the last rebuild?". It watches the project's source directories, never
// the project root recursively (that would walk node_modules and .next on every platform), debounces
// editor save bursts, and drops saves whose content hash didn't change (format-on-save that rewrote the
// same bytes, `touch`, git checkouts back and forth), so a no-op save is never attributed to a rebuild.
//
// Cost: nothing per request. fs.watch callbacks only record a path and arm one unref'd timer; hashing
// runs in that timer (or when the epoch tracker drains, which is off the request path). A one-time,
// chunked pre-hash of existing files runs at startup so the first save of an unchanged file is caught.
//
// Windows: a burst of more than ~40 writes (a git checkout, a codemod) overflows the watcher's change
// buffer and fs.watch reports one event with no file name: every name in the burst is lost. Such an
// event triggers a rescan in the flush: the watched dirs are walked and files modified since the last
// flush are hashed like any save (readdir + stat, capped by RESCAN_MAX_ENTRIES).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SourceChange {
  /** Project-relative path, `/` separators. */
  file: string;
  /** Wall-clock ms of the (last) save. */
  at: number;
  kind: "change" | "delete";
}

export interface SourceWatcher {
  /** Take every pending change saved at or before `t` (pending debounces are flushed first). */
  drain(t: number): SourceChange[];
  /** Pending changes, not taken. For tests and diagnostics. */
  peek(): SourceChange[];
  /** True when at least one directory is being watched. */
  readonly active: boolean;
  close(): void;
}

export interface SourceWatchOptions {
  /** Project-relative directories to watch recursively. Default: `src`, else common top-level dirs. */
  dirs?: string[];
  /** Quiet period after the last event before a file is hashed. Default 300ms. */
  debounceMs?: number;
  clock?: () => number;
  /** Pending changes kept between two rebuilds (oldest dropped). Default 200. */
  maxPending?: number;
  /** Files larger than this are never hashed (always count as changed). Default 1 MB. */
  maxHashBytes?: number;
  /** Pre-hash existing files at startup (chunked, off the event loop's critical path). Default true. */
  prehash?: boolean;
  /** Upper bound on files pre-hashed. Default 4000. */
  maxPrehash?: number;
  /** Re-arm attempts for missing / failed directories are throttled to this. Default 2000ms. */
  retryMs?: number;
}

/** Directories watched when the project has no `src/`. Each is watched only if it exists. */
export const FALLBACK_DIRS = [
  "app",
  "pages",
  "lib",
  "server",
  "components",
  "utils",
  "services",
  "features",
  "modules",
  "db",
  "prisma",
  "drizzle",
];

const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".sql",
  ".graphql",
  ".gql",
  ".prisma",
]);
const SKIP_SEGMENTS = new Set(["node_modules", "dist", "build", "out", "coverage"]);

/** True for a project-relative path whose change can affect server code. Exported for tests. */
export function isSourceFile(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/");
  const segs = norm.split("/");
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s.startsWith(".") || SKIP_SEGMENTS.has(s)) return false; // .next, .git, .turbo, .env*, ...
  }
  const base = segs[segs.length - 1] ?? "";
  if (/\.d\.[cm]?ts$/i.test(base) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return false;
  if (base === "package-lock.json" || base.endsWith(".tsbuildinfo")) return false;
  return SOURCE_EXT.has(path.extname(base).toLowerCase());
}

function hashFile(abs: string, maxBytes: number): string | null | undefined {
  // undefined = gone, null = unhashable (too big / unreadable): treat as changed.
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return null;
  if (st.size > maxBytes) return null;
  try {
    return createHash("sha1").update(fs.readFileSync(abs)).digest("base64");
  } catch {
    return null;
  }
}

/** Files hashed per flush; past this a burst is accepted as changed without reading the files. */
const FLUSH_HASH_BUDGET = 64;
/** Directory entries an overflow rescan may visit. */
const RESCAN_MAX_ENTRIES = 20000;
/** mtime slack for the rescan (coarse filesystem clocks, a save landing during the previous flush). */
const RESCAN_SLACK_MS = 2000;

export function watchSources(root: string, opts: SourceWatchOptions = {}): SourceWatcher {
  const clock = opts.clock ?? Date.now;
  const debounceMs = Math.max(0, opts.debounceMs ?? 300);
  const maxPending = Math.max(1, opts.maxPending ?? 200);
  const maxHashBytes = opts.maxHashBytes ?? 1024 * 1024;
  const retryMs = opts.retryMs ?? 2000;
  const dirs =
    opts.dirs ?? (isDir(path.join(root, "src")) ? ["src"] : FALLBACK_DIRS.filter((d) => isDir(path.join(root, d))));

  /** rel -> content hash as of the last accepted state. */
  const hashes = new Map<string, string | null>();
  /** rel -> time of the last raw event, waiting for the debounce. */
  const dirty = new Map<string, number>();
  /** rel -> accepted change, waiting for a rebuild. Insertion-ordered (oldest first). */
  const pending = new Map<string, SourceChange>();
  const watchers = new Map<string, fs.FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let armedAt = Number.NEGATIVE_INFINITY;
  /** Wall-clock ms (file mtimes are wall clock) of the last flush; an overflow rescans from here. */
  let flushedAt = Date.now();
  /** Set by a nameless (overflow) event: rescan files modified at or after this wall-clock ms. */
  let rescanFrom: number | undefined;

  const rescan = (from: number) => {
    const at = clock();
    let budget = RESCAN_MAX_ENTRIES;
    const visit = (rel: string) => {
      if (!isSourceFile(rel) || dirty.has(rel)) return;
      try {
        if (fs.statSync(path.join(root, rel)).mtimeMs >= from) dirty.set(rel, at);
      } catch {
        /* gone again */
      }
    };
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isFile()) visit(e.name);
    } catch {
      /* ignore */
    }
    const stack = [...dirs];
    while (stack.length && budget > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (budget-- <= 0) break;
        const rel = path.posix.join(dir.replace(/\\/g, "/"), e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith(".") && !SKIP_SEGMENTS.has(e.name)) stack.push(rel);
        } else if (e.isFile()) visit(rel);
      }
    }
  };

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (rescanFrom !== undefined) {
      const from = rescanFrom;
      rescanFrom = undefined;
      rescan(from);
    }
    flushedAt = Date.now();
    // Hashing is sync fs + crypto on the app's main thread. A branch switch can dirty thousands of
    // files at once: hash the first FLUSH_HASH_BUDGET (a no-op save must stay a no-op), and take the
    // rest as changed unhashed (their old hash is dropped, so the next save hashes them afresh).
    let budget = FLUSH_HASH_BUDGET;
    for (const [rel, at] of dirty) {
      if (budget-- <= 0) {
        hashes.delete(rel);
        pending.delete(rel);
        pending.set(rel, { file: rel, at, kind: "change" });
        while (pending.size > maxPending) {
          const oldest = pending.keys().next().value;
          if (oldest === undefined) break;
          pending.delete(oldest);
        }
        continue;
      }
      const h = hashFile(path.join(root, rel), maxHashBytes);
      const prev = hashes.get(rel);
      if (h === undefined) {
        // Deleted. Editors that save via rename (write tmp, rename over) fire a delete-ish event
        // first; hashFile then already sees the new file, so a real delete is a missing file.
        hashes.delete(rel);
        pending.delete(rel);
        pending.set(rel, { file: rel, at, kind: "delete" });
      } else if (h !== null && prev === h) {
        // Same bytes as before: a no-op save. If an earlier real change to this file is still
        // pending it stays pending (save, then undo-and-save is a real round trip only if hashes differ).
        continue;
      } else {
        hashes.set(rel, h);
        pending.delete(rel);
        pending.set(rel, { file: rel, at, kind: "change" });
      }
      while (pending.size > maxPending) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
    }
    dirty.clear();
  };

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };

  const onEvent = (dirRel: string, f: string | Buffer | null) => {
    if (f == null) {
      // Overflow (see the header): the names are gone, rescan by mtime.
      rescanFrom = Math.min(rescanFrom ?? Number.POSITIVE_INFINITY, flushedAt - RESCAN_SLACK_MS);
      schedule();
      return;
    }
    const rel = path.posix.join(dirRel.replace(/\\/g, "/"), String(f).replace(/\\/g, "/"));
    if (!isSourceFile(rel)) return;
    dirty.set(rel, clock());
    schedule();
  };

  const arm = () => {
    for (const d of dirs) {
      if (watchers.has(d)) continue;
      const abs = path.join(root, d);
      let w: fs.FSWatcher;
      try {
        w = fs.watch(abs, { persistent: false, recursive: true }, (_ev, f) => onEvent(d, f));
      } catch {
        continue; // missing, or recursive watch unsupported here: retried later
      }
      w.on("error", () => {
        w.close();
        watchers.delete(d);
      });
      watchers.set(d, w);
    }
    // Top-level files (proxy.ts, middleware.ts, instrumentation.ts): the root itself, NOT recursive.
    if (!watchers.has(".")) {
      try {
        const w = fs.watch(root, { persistent: false }, (_ev, f) => {
          if (f == null || (!String(f).includes("/") && !String(f).includes("\\"))) onEvent("", f);
        });
        w.on("error", () => {
          w.close();
          watchers.delete(".");
        });
        watchers.set(".", w);
      } catch {
        /* root unreadable: nothing to attribute */
      }
    }
  };

  const rearm = () => {
    const t = clock();
    if (closed || watchers.size >= dirs.length + 1 || t - armedAt < retryMs) return;
    armedAt = t;
    arm();
  };

  armedAt = clock();
  arm();
  if (opts.prehash !== false)
    prehash(
      root,
      dirs,
      hashes,
      maxHashBytes,
      opts.maxPrehash ?? 4000,
      () => closed,
      (rel) => dirty.has(rel),
    );

  return {
    drain(t: number) {
      if (dirty.size || rescanFrom !== undefined) flush();
      rearm();
      const out: SourceChange[] = [];
      for (const [rel, c] of pending) {
        if (c.at > t) continue;
        out.push(c);
        pending.delete(rel);
      }
      return out;
    },
    peek() {
      if (dirty.size || rescanFrom !== undefined) flush();
      return [...pending.values()];
    },
    get active() {
      return watchers.size > 0;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

/** Hash existing source files in small batches so the first save of an unchanged file is recognised. */
function prehash(
  root: string,
  dirs: string[],
  hashes: Map<string, string | null>,
  maxBytes: number,
  limit: number,
  stopped: () => boolean,
  busy: (rel: string) => boolean,
): void {
  const queue: string[] = [];
  const stack = [...dirs];
  // Top-level source files too (proxy.ts, instrumentation.ts).
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true }))
      if (e.isFile() && isSourceFile(e.name)) queue.push(e.name);
  } catch {
    /* ignore */
  }
  const step = () => {
    if (stopped()) return;
    let budget = 64;
    while (budget-- > 0 && hashes.size < limit) {
      const rel = queue.pop();
      if (rel !== undefined) {
        if (!hashes.has(rel) && !busy(rel)) {
          const h = hashFile(path.join(root, rel), maxBytes);
          if (h !== undefined && !hashes.has(rel)) hashes.set(rel, h);
        }
        continue;
      }
      const dir = stack.pop();
      if (dir === undefined) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = path.posix.join(dir.replace(/\\/g, "/"), e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith(".") && !SKIP_SEGMENTS.has(e.name)) stack.push(rel);
        } else if (e.isFile() && isSourceFile(rel)) queue.push(rel);
      }
    }
    if (hashes.size < limit && (queue.length || stack.length)) setImmediate(step).unref?.();
  };
  setImmediate(step).unref?.();
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
