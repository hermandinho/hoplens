// Request path: the opt-in last resort for the text V8 ran (generated.ts, step 3).
//
// Debugger.getScriptSource needs Debugger.enable, which replays a scriptParsed event for every
// script the isolate holds (~30-300ms on a mid-size app, probed). So it runs only when the user asked
// for it (RuntimeConfig.path.debuggerSource, or HOPLENS_PATH_DEBUGGER=1), only after a capture's
// final take (outside the window: the counts are already read), and only for the scripts a source
// map says are compiled with no retained text. The coverage session (coverage.ts) never enables the
// Debugger.
//
// The Debugger session is opened once and NEVER disabled or disconnected: Debugger.disable (a
// disconnect disables too) drops V8's debug info for every compiled function, block-coverage
// counters included, so precise coverage falls back to function counts for the rest of the process
// (probed on Node 22.20: isBlockCoverage false on every later take, and startPreciseCoverage does
// not bring them back). coverage.ts would then turn the request path off. Left enabled, block counts
// stay; the steady cost is one scriptParsed notification per script compiled later (no listener) and
// a later read pays only getScriptSource. The session is a process-wide singleton on globalThis.

import { createRequire } from "node:module";

const load = (id: string): any => createRequire(__filename)(id);

const KEY = Symbol.for("hoplens.debuggerSession");

export interface DebuggerSources {
  /** scriptId -> source. */
  sources: Map<string, string>;
  ms: number;
  error?: string;
}

export function debuggerFlag(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.HOPLENS_PATH_DEBUGGER;
  return v === "1" || v?.toLowerCase() === "true";
}

interface Session {
  post(method: string, params: object, cb: (err: Error | null, res: any) => void): void;
}

/** Synchronous post: throws when the inspector reports an error or did not answer inline. */
function call(session: Session, method: string, params: object = {}): any {
  let done = false;
  let error: Error | null = null;
  let result: any;
  session.post(method, params, (err, res) => {
    done = true;
    error = err;
    result = res;
  });
  if (error) throw error;
  if (!done) throw new Error(`${method} did not answer synchronously`);
  return result;
}

/** The process's Debugger-enabled session, opened (and enabled) on first use, kept for good. */
function session(): Session {
  const g = globalThis as any;
  if (g[KEY]) return g[KEY];
  const inspector = load("node:inspector");
  const s = new inspector.Session();
  s.connect();
  // Enable before publishing it: a failed enable leaves no session behind (nothing was enabled, so
  // nothing is lost by disconnecting it).
  try {
    call(s, "Debugger.enable");
  } catch (err) {
    try {
      s.disconnect();
    } catch {
      /* already closed */
    }
    throw err;
  }
  g[KEY] = s;
  return s;
}

/** Read the sources of `ids` through the process's Debugger session. Never throws. */
export function debuggerSources(ids: readonly string[]): DebuggerSources {
  const t0 = performance.now();
  const sources = new Map<string, string>();
  if (!ids.length) return { sources, ms: 0 };
  try {
    const s = session();
    for (const id of ids) {
      try {
        const r = call(s, "Debugger.getScriptSource", { scriptId: id });
        if (typeof r?.scriptSource === "string") sources.set(id, r.scriptSource);
      } catch {
        /* that script is gone */
      }
    }
    return { sources, ms: performance.now() - t0 };
  } catch (err) {
    return { sources, ms: performance.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}
