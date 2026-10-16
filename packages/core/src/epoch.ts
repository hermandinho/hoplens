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
import { type SourceChange, type SourceWatcher, watchSources } from "./sourcewatch";

/**
 * Wall-clock ms of the newest relevant change (0 = none yet). A probe may also hand out the names of
 * the build-output files it saw change since the last call (`drainNames`), used as attribution
 * candidates when no source change was seen.
 */
export type MtimeProbe = (() => number) & { drainNames?: () => string[] };

/** Build-output names kept between two drains. */
const MAX_PROBE_NAMES = 100;

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
): MtimeProbe {
  const base = path.join(root, distDir);
  const dirs = [path.join(base, "dev", "server"), path.join(base, "server")];
  const watchers = new Map<string, fs.FSWatcher>();
  const names = new Set<string>();
  let last = 0;
  let armedAt = Number.NEGATIVE_INFINITY;
  const arm = () => {
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      let w: fs.FSWatcher;
      try {
        w = fs.watch(dir, { persistent: false, recursive: true }, (_ev, f) => {
          if (f == null || !isRebuildFile(String(f))) return;
          last = clock();
          if (names.size < MAX_PROBE_NAMES) names.add(String(f).replace(/\\/g, "/"));
        });
      } catch {
        continue; // not created yet (or recursive watch unsupported): retried later
      }
      w.on("error", () => {
        w.close();
        watchers.delete(dir); // e.g. `rm -rf .next`: re-armed by a later probe
      });
      watchers.set(dir, w);
    }
  };
  const probe: MtimeProbe = () => {
    const t = clock();
    if (watchers.size < dirs.length && t - armedAt >= retryMs) {
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
}

/** Files listed per epoch. */
export const MAX_EPOCH_FILES = 50;

export type EpochListener = (info: EpochInfo) => void;

export interface EpochTrackerOptions {
  /** Source watcher whose pending changes are attributed to the next rebuild. */
  sources?: SourceWatcher;
  /** EpochInfo entries kept (newest win). Default 50. */
  maxInfos?: number;
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

  /** Release the source watcher (tests, shutdown). */
  close(): void {
    this.sources?.close();
  }

  private bump(t: number, mtime: number, names: string[]): void {
    this.epoch++;
    let changes: SourceChange[] = [];
    try {
      changes = this.sources?.drain(t) ?? [];
    } catch {
      /* attribution is best effort */
    }
    const files = changes.map((c) => c.file).sort();
    const candidates = candidatesFromChunks(names);
    const info: EpochInfo = {
      id: this.epoch,
      at: t,
      rebuiltAt: mtime,
      files: files.slice(0, MAX_EPOCH_FILES),
      deleted: changes
        .filter((c) => c.kind === "delete")
        .map((c) => c.file)
        .sort()
        .slice(0, MAX_EPOCH_FILES),
      moreFiles: Math.max(0, files.length - MAX_EPOCH_FILES),
      via: files.length ? "src-watch" : candidates.length ? "candidates" : "unknown",
      candidates,
    };
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
        if (!newCompile && !settling) this.bump(t, m, names);
      }
    }
    if (newCompile) this.lastNewCompileAt = t;
    const firstInEpoch = this.seen.get(routeKey) !== this.epoch;
    // Re-insert so the Map's order tracks recency, then evict the least recently seen.
    this.seen.delete(routeKey);
    this.seen.set(routeKey, this.epoch);
    if (this.seen.size > this.maxRoutes) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return { epoch: this.epoch, firstInEpoch };
  }
}

/**
 * The runtime's tracker: the built-chunk detector as the rebuild signal plus a source watcher for
 * attribution. `sources: false` skips the watcher (tests, or a project where watching isn't wanted).
 */
export function createEpochTracker(root: string, distDir: string, opts: { sources?: boolean } = {}): EpochTracker {
  let sources: SourceWatcher | undefined;
  if (opts.sources !== false) {
    try {
      sources = watchSources(root);
    } catch {
      sources = undefined; // attribution is best effort; epochs and cold facts work without it
    }
  }
  return new EpochTracker(distMtimeProbe(root, distDir), 250, Date.now, 2000, 5000, { sources });
}
