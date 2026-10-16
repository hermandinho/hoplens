// Coarse "dev rebuild" epochs, used for the `cold` and `epoch` facts.
//
// Signal: writes of compiled server code in the dev build output (`<distDir>/dev/server` on Next 16,
// `<distDir>/server` otherwise), seen through fs.watch. Measured on Next 16 + Turbopack: an edit
// rewrites chunk files in `chunks/` in place, which leaves every directory mtime unchanged, while
// Next rewrites the top-level `*manifest*` files (atomic rename, so the directory mtime moves) and
// touches `app/<route>` directories with no edit at all, e.g. when it disposes an idle route. So the
// probe counts only `.js` files whose name doesn't contain "manifest" (webpack's rewritten route
// bundles and hot-update files pass too) and ignores directory events, `.map` files and manifests.
// The watchers are created lazily by the first probe (retried while the directories don't exist),
// never keep the process alive, and cost nothing per request: the probe just reads a timestamp.
// It runs from finalize() after the response finished, throttled to one probe per `minProbeMs`.
//
// Caveat: Next compiles routes on demand, so the first hit on a never-seen route also writes there.
// That request already paid the compile itself, so a change observed while a request compiled a route
// we've never seen is attributed to that compile, not to an edit, and doesn't bump the epoch.
// Otherwise every first visit would mark all other routes cold again. Because bundlers can finish
// writing chunks after the response, compiling requests always probe (skipping the throttle), and a
// change made, or first seen, within `settleMs` after a new-route compile is absorbed too.

import fs from "node:fs";
import path from "node:path";
import { type ChunkDiff, ChunkIndex, type ChunkUpdate, dirIdent, serverDirs } from "./chunkindex";
import { type SourceChange, type SourceWatcher, watchSources } from "./sourcewatch";

/**
 * Wall-clock ms of the newest relevant change (0 = none yet). A probe may also hand out the names of
 * the build-output files it saw change since the last call (`drainNames`), used as attribution
 * candidates when no source change was seen.
 */
export type MtimeProbe = (() => number) & {
  drainNames?: () => string[];
  /** WP9c: absolute paths of the build-output files written since the last call (for the chunk diff). */
  drainPaths?: () => { paths: string[]; overflow: boolean };
  /** Close the build-output watchers (Runtime.stop). */
  close?: () => void;
};

/** Build-output names kept between two drains. */
const MAX_PROBE_NAMES = 100;
/** Build-output paths kept between two drains for the chunk diff; past this the diff is untrusted. */
const MAX_PROBE_PATHS = 2000;

export interface DistProbeOptions {
  /** Called when a watcher on an output dir is (re)armed, e.g. after `rm -rf .next`. */
  onArm?: (dir: string) => void;
}

/** True for a changed file that means "server code was rebuilt". Exported for tests. */
export function isRebuildFile(filename: string): boolean {
  const name = path.basename(filename);
  return /\.[cm]?js$/i.test(name) && !/manifest/i.test(name);
}

export function distMtimeProbe(
  root: string,
  distDir: string,
  clock: () => number = Date.now,
  retryMs = 2000,
  opts: DistProbeOptions = {},
): MtimeProbe {
  const dirs = serverDirs(root, distDir);
  const watchers = new Map<string, { w: fs.FSWatcher; ident: string }>();
  const names = new Set<string>();
  const paths = new Set<string>();
  let overflow = false;
  let last = 0;
  let armedAt = Number.NEGATIVE_INFINITY;
  const drop = (dir: string) => {
    const cur = watchers.get(dir);
    if (!cur) return;
    try {
      cur.w.close();
    } catch {
      /* already closed */
    }
    watchers.delete(dir);
  };
  const arm = () => {
    for (const dir of dirs) {
      const ident = dirIdent(dir);
      const cur = watchers.get(dir);
      // `rm -rf .next` doesn't always error the watcher (Linux just stops delivering events): a dir
      // whose identity changed is a new dir and gets a new watcher.
      if (cur && cur.ident === ident) continue;
      if (cur) drop(dir);
      if (!ident) continue; // not created yet: retried later
      let w: fs.FSWatcher;
      try {
        w = fs.watch(dir, { persistent: false, recursive: true }, (_ev, f) => {
          if (f == null) {
            // Windows: a write burst (> ~40 files) overflowed the change buffer and every name in it
            // was lost. It is a rebuild; the chunk index sweeps the output by mtime (ChunkIndex.update).
            last = clock();
            overflow = true;
            return;
          }
          if (!isRebuildFile(String(f))) return;
          last = clock();
          if (names.size < MAX_PROBE_NAMES) names.add(String(f).replace(/\\/g, "/"));
          if (paths.size < MAX_PROBE_PATHS) paths.add(path.join(dir, String(f)));
          else overflow = true;
        });
      } catch {
        continue; // recursive watch unsupported, or gone again: retried later
      }
      w.on("error", () => {
        // e.g. `rm -rf .next` on Windows: re-armed by a later probe
        if (watchers.get(dir)?.w === w) drop(dir);
      });
      watchers.set(dir, { w, ident });
      try {
        opts.onArm?.(dir);
      } catch {
        /* best effort */
      }
    }
  };
  const probe: MtimeProbe = () => {
    const t = clock();
    // Throttled: also re-checks the identity of armed dirs, so a wiped and recreated dir is re-armed.
    if (t - armedAt >= retryMs) {
      armedAt = t;
      arm();
    }
    return last;
  };
  probe.drainNames = () => {
    const out = [...names];
    names.clear();
    return out;
  };
  probe.drainPaths = () => {
    const out = { paths: [...paths], overflow };
    paths.clear();
    overflow = false;
    return out;
  };
  probe.close = () => {
    for (const dir of [...watchers.keys()]) drop(dir);
    armedAt = Number.POSITIVE_INFINITY; // never re-arm
  };
  return probe;
}

/**
 * Attribution hints from build-output names: `app/api/feed/route.js` -> `app/api/feed/route`, Next's
 * `..._next-internal_server_app_api_db_products_route_actions_...js` -> `app/api/db/products/route`,
 * webpack-style `src_lib_store_ts.js` -> `src/lib/store.ts` (underscores are ambiguous, so these are
 * only candidates). Content-hashed chunk names (`[root-of-the-server]__0ew9._.js`) say nothing and
 * are dropped. Exported for tests.
 */
export function candidatesFromChunks(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const n = raw.replace(/\\/g, "/");
    const route = /(?:^|\/)((?:app|pages)\/.+?\/(?:route|page))\.[cm]?js$/.exec(n);
    if (route) {
      out.add(route[1]!);
      continue;
    }
    const internal = /_next-internal_server_app_(.+?)_(route|page)_actions_/.exec(n);
    if (internal) {
      out.add(`app/${internal[1]!.replace(/_/g, "/")}/${internal[2]}`);
      continue;
    }
    const mod = /(?:^|\/)(src|lib|server)_([\w-]+?)_(tsx?|jsx?|mjs|cjs)(?:[_.][\w.-]*)?\.js$/.exec(n);
    if (mod) out.add(`${mod[1]}/${mod[2]!.replace(/_/g, "/")}.${mod[3]}`);
  }
  return [...out].sort();
}

/* ------------------------------------------------------------ epoch info */

export type EpochVia =
  /** Epoch 0: process start. */
  | "start"
  /** Source files saved (content changed) before this rebuild, seen by the source watcher. */
  | "src-watch"
  /** No confirmed source save; the changed modules in the rebuilt chunks name the files (WP9c). */
  | "chunk-diff"
  /** No source change seen; hints derived from the rebuilt chunk names. */
  | "candidates"
  /** A rebuild with nothing to attribute it to. */
  | "unknown";

export interface EpochInfo {
  /** Epoch number (same as the `epoch` fact). */
  id: number;
  /** Wall-clock ms the rebuild was noticed (the request that bumped the epoch finished). */
  at: number;
  /** Watcher time of the newest build-output write seen when the epoch bumped (0 = unknown). */
  rebuiltAt: number;
  /** Project-relative source files changed since the previous epoch, `/` separators, capped. */
  files: string[];
  /** Files deleted (subset of `files`). */
  deleted: string[];
  /** Changed files beyond the cap. */
  moreFiles: number;
  via: EpochVia;
  /** Build-output hints (route or module paths) from rebuilt chunk names. */
  candidates: string[];
  /**
   * WP9c: set when the module-level chunk diff was trusted. `routes` = compiled routes whose chunks
   * contain a changed module; `compiled` = every route compiled at that point. Internal: api/epochs
   * turns it into `routes` / `routesVia: "chunks"` and leaves it out of the response.
   */
  chunkScope?: { routes: string[]; compiled: string[] };
  /** WP10: set on epochs restored from an earlier dev session (`persist: true`); absent for this one. */
  session?: number;
}

/** Files listed per epoch. */
export const MAX_EPOCH_FILES = 50;

export type EpochListener = (info: EpochInfo) => void;

export interface EpochTrackerOptions {
  /** Source watcher whose pending changes are attributed to the next rebuild. */
  sources?: SourceWatcher;
  /** EpochInfo entries kept (newest win). Default 50. */
  maxInfos?: number;
  /** WP9c: module-level diff of the rebuilt chunks (no-op rebuilds create no epoch; chunk-diff attribution). */
  chunks?: ChunkDiffer;
}

/** The part of ChunkIndex the tracker uses (stubbed in tests). */
export interface ChunkDiffer {
  update(paths: readonly string[], overflow?: boolean): ChunkUpdate;
  describe(ids: Iterable<string>, trusted?: boolean): ChunkDiff;
  close?(): void;
}

export interface EpochObservation {
  epoch: number;
  /** First finished request for this route key in the current epoch. */
  firstInEpoch: boolean;
}

export class EpochTracker {
  epoch = 0;
  private lastMtime = -1;
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  /** When a request last compiled a route we had never seen. */
  private lastNewCompileAt = Number.NEGATIVE_INFINITY;
  /** route key -> epoch it was last seen in. Insertion-ordered, oldest evicted first. */
  private readonly seen = new Map<string, number>();
  /** Ring of recent epochs, oldest first. */
  private readonly infos: EpochInfo[] = [];
  private readonly listeners = new Set<EpochListener>();
  private readonly sources?: SourceWatcher;
  private readonly chunks?: ChunkDiffer;
  /** Edits (modified/removed modules) seen in absorbed rebuilds, owed to the next bump decision. */
  private readonly carried = new Set<string>();
  private carriedUntrusted = false;
  private readonly maxInfos: number;

  constructor(
    private readonly probe: MtimeProbe,
    private readonly minProbeMs = 250,
    private readonly clock: () => number = Date.now,
    private readonly settleMs = 2000,
    private readonly maxRoutes = 5000,
    opts: EpochTrackerOptions = {},
  ) {
    this.sources = opts.sources;
    this.chunks = opts.chunks;
    this.maxInfos = Math.max(1, opts.maxInfos ?? 50);
    this.infos.push({
      id: 0,
      at: clock(),
      rebuiltAt: 0,
      files: [],
      deleted: [],
      moreFiles: 0,
      via: "start",
      candidates: [],
    });
  }

  /** Recent epochs, oldest first (a copy). */
  list(): EpochInfo[] {
    return this.infos.slice();
  }

  /** Info for one epoch, if still in the ring. */
  info(id: number): EpochInfo | undefined {
    for (let i = this.infos.length - 1; i >= 0; i--) if (this.infos[i]!.id === id) return this.infos[i];
    return undefined;
  }

  /** Subscribe to epoch bumps. Listeners run synchronously from observe(); keep them cheap. */
  onEpoch(fn: EpochListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** True while a source watcher is attached and watching at least one directory. */
  get watchingSources(): boolean {
    return this.sources?.active ?? false;
  }

  /** Release the source and build-output watchers (tests, shutdown). */
  close(): void {
    this.sources?.close();
    this.chunks?.close?.();
    try {
      this.probe.close?.();
    } catch {
      /* best effort */
    }
  }

  /**
   * WP10: continue after a persisted session. This session starts at epoch `base` and `prior` (earlier
   * sessions' epochs, each with `session` set) go before it in the ring. Only before the first bump.
   */
  restore(base: number, prior: readonly EpochInfo[]): void {
    if (this.epoch !== 0 || this.infos.length !== 1 || base <= 0) return;
    this.epoch = base;
    this.infos[0]!.id = base;
    const keep = prior.filter((i) => i.id < base).slice(-(this.maxInfos - 1));
    this.infos.unshift(...keep);
  }

  private drainSources(t: number): SourceChange[] {
    try {
      return this.sources?.drain(t) ?? [];
    } catch {
      return []; /* attribution is best effort */
    }
  }

  /**
   * Diff the written chunks. Returns the module ids that changed for this decision and whether that's
   * trustworthy, or undefined without a chunk index. `absorb` = this rebuild won't bump: its edits are
   * carried to the next decision (a new-route compile can be the first to write an edited module).
   */
  private chunkDiff(absorb: boolean): { edits: string[]; added: string[]; trusted: boolean } | undefined {
    if (!this.chunks) return undefined;
    let u: ChunkUpdate;
    try {
      const d = this.probe.drainPaths?.();
      if (!d) return undefined;
      u = this.chunks.update(d.paths, d.overflow);
    } catch {
      return undefined;
    }
    if (absorb) {
      for (const id of [...u.modified, ...u.removed]) this.carried.add(id);
      if (!u.trusted) this.carriedUntrusted = true;
      return undefined;
    }
    const edits = new Set([...u.modified, ...u.removed, ...this.carried]);
    const trusted = u.trusted && !this.carriedUntrusted;
    this.carried.clear();
    this.carriedUntrusted = false;
    return { edits: [...edits], added: u.added, trusted };
  }

  private bump(
    t: number,
    mtime: number,
    names: string[],
    diff?: { edits: string[]; added: string[]; trusted: boolean },
  ): void {
    this.epoch++;
    const changes = this.drainSources(t);
    let files = changes.map((c) => c.file).sort();
    let deleted = changes.filter((c) => c.kind === "delete").map((c) => c.file);
    let candidates = candidatesFromChunks(names);
    let via: EpochVia = files.length ? "src-watch" : candidates.length ? "candidates" : "unknown";
    let chunkScope: EpochInfo["chunkScope"];
    if (diff?.trusted && this.chunks) {
      let d: ChunkDiff | undefined;
      try {
        // Files and routes come from edited modules only. Added ones (seen for the first time: a new
        // import, or a chunk the watcher missed) only confirm a save the watcher saw.
        d = this.chunks.describe(diff.edits, true);
      } catch {
        d = undefined;
      }
      if (d) {
        // A save the watcher saw is kept only if the rebuilt code confirms it (or it deleted a file); a
        // save that changed no server module (formatting, a client-only file) is dropped.
        const confirmed = new Set(d.files);
        if (diff.added.length) for (const f of this.chunks.describe(diff.added, true).files) confirmed.add(f);
        const saved = new Set(changes.filter((c) => c.kind === "delete" || confirmed.has(c.file)).map((c) => c.file));
        files = [...new Set([...d.files, ...saved])].sort();
        deleted = deleted.filter((f) => saved.has(f));
        if (!files.length) candidates = [...new Set([...d.external, ...candidates])].sort();
        via = saved.size ? "src-watch" : files.length ? "chunk-diff" : candidates.length ? "candidates" : "unknown";
        chunkScope = { routes: d.routes, compiled: d.compiled };
      }
    }
    const info: EpochInfo = {
      id: this.epoch,
      at: t,
      rebuiltAt: mtime,
      files: files.slice(0, MAX_EPOCH_FILES),
      deleted: deleted.sort().slice(0, MAX_EPOCH_FILES),
      moreFiles: Math.max(0, files.length - MAX_EPOCH_FILES),
      via,
      candidates,
    };
    if (chunkScope) info.chunkScope = chunkScope;
    this.infos.push(info);
    if (this.infos.length > this.maxInfos) this.infos.shift();
    for (const fn of this.listeners) {
      try {
        fn(info);
      } catch {
        /* a listener must never break the request's finalize */
      }
    }
  }

  /**
   * Record a finished request. `compiled` = this request ran Next's compile phase at all (any compile
   * span). Combined with "route never seen", that marks the on-demand compile of a new route; it must
   * not require a heavy compile, since a small route's first compile can take well under 100ms.
   * Call off the hot path.
   */
  observe(routeKey: string, compiled: boolean): EpochObservation {
    const known = this.seen.has(routeKey);
    const t = this.clock();
    const newCompile = compiled && !known;
    if (newCompile || t - this.lastProbeAt >= this.minProbeMs) {
      this.lastProbeAt = t;
      const m = this.probe();
      if (this.lastMtime < 0) this.lastMtime = m;
      else if (m > this.lastMtime) {
        this.lastMtime = m;
        // An on-demand compile of a brand-new route isn't an edit, nor are the chunk writes that
        // trail it and get noticed by the next (unrelated) request.
        const after = (x: number) => x >= this.lastNewCompileAt && x - this.lastNewCompileAt <= this.settleMs;
        const settling = after(t) || after(m);
        // Chunk names collected since the last change belong to this one, bump or not.
        const names = this.probe.drainNames?.() ?? [];
        const absorb = newCompile || settling;
        const diff = this.chunkDiff(absorb);
        if (!absorb) {
          if (diff?.trusted && diff.edits.length === 0) {
            // WP9c: chunks were rewritten but no existing module's code changed (format-on-save,
            // `touch`, a client-only edit, or the late writes of a route compiled for the first time,
            // which only add modules): no epoch. The saves behind it are dropped so they can't be pinned on
            // the next real rebuild.
            this.drainSources(Math.min(t, m));
          } else this.bump(t, m, names, diff);
        }
      }
    }
    if (newCompile) this.lastNewCompileAt = t;
    const last = this.seen.get(routeKey);
    // First in this epoch, unless the bundler said every edit since it was last seen left its chunks
    // alone (and it ran no compile now): a route a save did not rebuild serves warm.
    const firstInEpoch =
      last !== this.epoch && (compiled || last === undefined || !this.untouchedSince(routeKey, last));
    // Re-insert so the Map's order tracks recency, then evict the least recently seen.
    this.seen.delete(routeKey);
    this.seen.set(routeKey, this.epoch);
    if (this.seen.size > this.maxRoutes) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return { epoch: this.epoch, firstInEpoch };
  }

  /**
   * True when every epoch after `since` (up to the current one) has a trusted chunk scope in which the
   * route was compiled but not rebuilt. Unknown (an evicted epoch, no chunk diff, a route the scope
   * doesn't list) is false: cold, as before.
   */
  private untouchedSince(routeKey: string, since: number): boolean {
    const template = routeKey.slice(routeKey.indexOf(" ") + 1);
    for (let id = since + 1; id <= this.epoch; id++) {
      const scope = this.info(id)?.chunkScope;
      if (!scope || !scope.compiled.includes(template) || scope.routes.includes(template)) return false;
    }
    return true;
  }
}

/**
 * The runtime's tracker: the built-chunk detector as the rebuild signal plus a source watcher for
 * attribution. `sources: false` skips the watcher (tests, or a project where watching isn't wanted).
 */
export function createEpochTracker(
  root: string,
  distDir: string,
  /** `chunks`: build the module-level chunk index. Default: on, except when NODE_ENV=production. */
  opts: { sources?: boolean; chunks?: boolean } = {},
): EpochTracker {
  let sources: SourceWatcher | undefined;
  if (opts.sources !== false) {
    try {
      sources = watchSources(root);
    } catch {
      sources = undefined; // attribution is best effort; epochs and cold facts work without it
    }
  }
  let chunks: ChunkIndex | undefined;
  // A production server (HOPLENS_FORCE=1) never rewrites its build output, so the index could never
  // diff anything: don't spend the background prime (up to 96 MB read) on it.
  if (opts.chunks ?? process.env.NODE_ENV !== "production") {
    try {
      chunks = new ChunkIndex(root, distDir);
    } catch {
      chunks = undefined; // the module diff is best effort; the chunk detector alone still bumps
    }
  }
  const probe = distMtimeProbe(root, distDir, Date.now, 2000, { onArm: (dir) => chunks?.rearm(dir) });
  return new EpochTracker(probe, 250, Date.now, 2000, 5000, { sources, chunks });
}
