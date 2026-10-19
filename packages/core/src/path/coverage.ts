// Request path, layer 1: V8 precise block coverage, started once at boot and never stopped.
//
// Built as its own entry (`@hoplens/core/coverage`, dist/coverage.js) so the Express register hook
// can start it before any app module loads without loading the rest of core earlier than it does
// today. Nothing here imports at module level but node:module: `node:inspector` and
// `node:worker_threads` are required inside startCoverage(), which callers reach only with
// HOPLENS_PATH=1 set (node:module is always loaded by Node itself). With the flag unset this file is never loaded (the register hook checks the
// env itself) and no inspector session ever exists.
//
// Rules (plan P1, risks):
// - Main thread only. Coverage is per isolate; a worker would report its own.
// - Refuse under NODE_V8_COVERAGE (c8 / Node's own coverage dump): starting a second precise
//   coverage session there and taking from it resets the counts c8 is about to write. State
//   'disabled-c8'.
// - Never call Profiler.stopPreciseCoverage and never enable the Debugger: the session lives as long
//   as the process. (A static test asserts this file never names the stop method.)
// - Precise mode is global to the isolate: another inspector session (DevTools' Coverage panel under
//   --inspect, a tool's own Session) that stops precise coverage, or that disables its Debugger
//   (a detach does too: V8 drops its debug info, block counters included; scriptsource.ts never
//   disables its own for that reason), downgrades ours to best-effort
//   function counts that never reset. take() watches for it (BlockWatch) and turns the state to
//   'error' with a restart hint; it re-posts startPreciseCoverage so call counts reset again.
// - take() is synchronous: Session.post runs its callback before it returns for Profiler commands
//   (probed on Node 22.20). A callback that did not run yet is reported as a failed take.
// - The handle is a process-wide singleton on globalThis, so dist/coverage.js (loaded by the register
//   hook) and dist/index.js (loaded at boot) share it.
// - Next (P6): @hoplens/next's node.ts calls startCoverage() from core's main entry, first thing in
//   the instrumentation hook, which Next runs before the first request's proxy and route code
//   (packages/next/src/path.ts says why that is early enough).

import { createRequire } from "node:module";

/**
 * Builtins only, loaded lazily. process.getBuiltinModule first (Node 20.16+ / 22.3+): a bundler
 * that inlines core (Turbopack bundles a workspace-linked @hoplens/core into Next's instrumentation
 * chunk despite serverExternalPackages) rewrites `__filename`, and createRequire needs a real one.
 */
const load = (id: string): any => {
  const builtin = (process as any).getBuiltinModule as ((id: string) => unknown) | undefined;
  const m = typeof builtin === "function" ? builtin(id) : undefined;
  return m ?? createRequire(__filename)(id);
};

export type CoverageState = "off" | "on" | "disabled-c8" | "error";

export interface CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface FunctionCoverage {
  functionName: string;
  ranges: CoverageRange[];
  isBlockCoverage: boolean;
}

export interface ScriptCoverage {
  scriptId: string;
  url: string;
  functions: FunctionCoverage[];
}

export interface TakeResult {
  /** Scripts that passed the filter (all of them without one). */
  scripts: ScriptCoverage[];
  /** Scripts V8 reported before filtering. */
  total: number;
  /** Wall time of the take, ms. */
  ms: number;
}

/** What capture.ts needs: the state, and a take that resets every counter to zero. */
export interface CoverageSource {
  readonly state: CoverageState;
  readonly reason?: string;
  /**
   * Take (and reset) the counts. `keep(url, script)` is applied right away, so dropped scripts are
   * never held; it sees every script of the take (a bundled-script filter records them: bundled.ts).
   * Undefined when coverage is not on or the take failed.
   */
  take(keep?: (url: string, script: ScriptCoverage) => boolean): TakeResult | undefined;
}

const KEY = Symbol.for("hoplens.coverage");

/** Functions BlockWatch remembers as having block counts (a bounded sample is enough). */
const WATCH_MAX = 512;

export const DOWNGRADED_REASON =
  "another inspector session stopped precise coverage or detached a debugger (DevTools' Coverage panel, a debugger under --inspect?), which drops V8's block counts; restart the app to use Trace path";

/**
 * Detects precise coverage downgraded to best-effort by another session: a function V8 once reported
 * with block counts comes back without them. (Functions compiled before coverage started never have
 * block counts; they are not a downgrade.) It remembers the WATCH_MAX functions that ran most
 * recently, so the sample stays on code that runs again (a request's own functions), not on module
 * bodies that ran once at boot. Exported for tests.
 */
export class BlockWatch {
  private readonly seen = new Map<string, true>();
  downgraded(scripts: readonly ScriptCoverage[]): boolean {
    for (const s of scripts) {
      for (const f of s.functions) {
        const r0 = f.ranges[0];
        if (!r0) continue;
        // Start offsets alone collide (V8 reports some uncompiled functions at offset 0, where the
        // module function starts): the end offset and name tell them apart.
        const id = `${s.scriptId}:${r0.startOffset}:${r0.endOffset}:${f.functionName}`;
        if (!f.isBlockCoverage) {
          if (this.seen.has(id)) return true;
        } else if (r0.count > 0) {
          this.seen.delete(id);
          this.seen.set(id, true);
          if (this.seen.size > WATCH_MAX) this.seen.delete(this.seen.keys().next().value as string);
        }
      }
    }
    return false;
  }
}

type Env = Record<string, string | undefined>;

/** HOPLENS_PATH=1 (or true). Read at boot only: coverage that starts late misses every loaded function. */
export function pathFlag(env: Env = process.env): boolean {
  const v = env.HOPLENS_PATH;
  return v === "1" || v?.toLowerCase() === "true";
}

/** The process's coverage handle, if the boot hook created one. Never creates it. */
export function coverageHandle(): CoverageSource | undefined {
  return (globalThis as any)[KEY];
}

interface InspectorSession {
  connect(): void;
  post(method: string, params: object, cb: (err: Error | null, res: any) => void): void;
}

class Coverage implements CoverageSource {
  state: CoverageState = "off";
  reason?: string;
  private session?: InspectorSession;
  private readonly watch = new BlockWatch();

  start(env: Env): void {
    if (env.NODE_V8_COVERAGE) {
      this.state = "disabled-c8";
      this.reason = "NODE_V8_COVERAGE is set (c8 or Node's coverage dump owns the counters)";
      return;
    }
    const { isMainThread } = load("node:worker_threads") as typeof import("node:worker_threads");
    if (!isMainThread) {
      this.state = "off";
      this.reason = "worker thread";
      return;
    }
    const inspector = load("node:inspector") as typeof import("node:inspector");
    const s = new inspector.Session() as unknown as InspectorSession;
    s.connect();
    this.session = s;
    this.call("Profiler.enable", {});
    this.call("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    this.state = "on";
  }

  /** Synchronous post: throws when the inspector reports an error or did not answer inline. */
  private call(method: string, params: object): any {
    let done = false;
    let error: Error | null = null;
    let result: any;
    this.session!.post(method, params, (err, res) => {
      done = true;
      error = err;
      result = res;
    });
    if (error) throw error;
    if (!done) throw new Error(`${method} did not answer synchronously`);
    return result;
  }

  take(keep?: (url: string, script: ScriptCoverage) => boolean): TakeResult | undefined {
    if (this.state !== "on") return undefined;
    const t0 = performance.now();
    try {
      const res = this.call("Profiler.takePreciseCoverage", {});
      const all: ScriptCoverage[] = Array.isArray(res?.result) ? res.result : [];
      if (this.watch.downgraded(all)) {
        this.state = "error";
        this.reason = DOWNGRADED_REASON;
        try {
          // Call counts reset on take again; block counts do not come back for compiled functions.
          this.call("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
        } catch {
          /* the state already says it */
        }
        return undefined;
      }
      const scripts = keep ? all.filter((s) => typeof s.url === "string" && keep(s.url, s)) : all;
      return { scripts, total: all.length, ms: performance.now() - t0 };
    } catch {
      return undefined;
    }
  }
}

/**
 * Start block coverage for this process (idempotent: the first call wins). Never throws: a failure
 * leaves state 'error' with the reason, and the app runs as it would without Hoplens.
 */
export function startCoverage(env: Env = process.env): CoverageSource {
  const g = globalThis as any;
  if (g[KEY]) return g[KEY];
  const cov = new Coverage();
  g[KEY] = cov;
  try {
    cov.start(env);
  } catch (err) {
    cov.state = "error";
    cov.reason = err instanceof Error ? err.message : String(err);
  }
  return cov;
}
