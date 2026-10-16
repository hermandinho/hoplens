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

/** Wall-clock ms of the newest relevant change (0 = none yet). */
export type MtimeProbe = () => number;

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
  let last = 0;
  let armedAt = Number.NEGATIVE_INFINITY;
  const arm = () => {
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      let w: fs.FSWatcher;
      try {
        w = fs.watch(dir, { persistent: false, recursive: true }, (_ev, f) => {
          if (f != null && isRebuildFile(String(f))) last = clock();
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
  return () => {
    const t = clock();
    if (watchers.size < dirs.length && t - armedAt >= retryMs) {
      armedAt = t;
      arm();
    }
    return last;
  };
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

  constructor(
    private readonly probe: MtimeProbe,
    private readonly minProbeMs = 250,
    private readonly clock: () => number = Date.now,
    private readonly settleMs = 2000,
    private readonly maxRoutes = 5000,
  ) {}

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
        if (!newCompile && !settling) this.epoch++;
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
