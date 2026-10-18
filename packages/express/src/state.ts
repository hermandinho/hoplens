// Process-wide adapter state. dist/index.js and dist/register.js are separate bundles, so each has
// its own copy of every module: anything that must happen once lives here, on globalThis.

import type { HoplensOptions, Runtime } from "@hoplens/core";
import type { ExpressInfo } from "./resolve";
import type { RoutesState } from "./routes";

export interface AdapterState {
  /** http/https Server.prototype.listen is wrapped (undone after the first app listen). */
  listenPatched: boolean;
  /** Undo the listen wrappers. */
  restoreListen?: () => void;
  /** Inside our own listen hook: a listen made while booting is not the app's. */
  inListen: boolean;
  booting: boolean;
  /** A boot failed once: never retry, never log again. */
  failed: boolean;
  express?: ExpressInfo;
  /** Route/dispatch patches on the app's express (routes.ts), once per process. */
  routes?: RoutesState;
  /** Patching express failed once: never retried. */
  routesFailed?: boolean;
  /** Options from hoplens(app, opts), applied when the deferred boot runs. */
  pendingOpts?: HoplensOptions;
  /** Function hops (autotrace.ts + the transform's ESM hook): what the register hook set up and saw. */
  autoTrace?: AutoTraceStats;
  /** The code-level autoTrace hint was printed. */
  autoTraceHinted?: boolean;
  /** hoplens() with no app listen ahead of it: boot anyway after a while. */
  lateTimer?: NodeJS.Timeout;
  banner: {
    printed: boolean;
    uiReady: boolean;
    appPort?: number;
    /** Booted with no app listen ahead: print without waiting for one. */
    noAppListen?: boolean;
    rt?: Runtime;
    timer?: NodeJS.Timeout;
  };
}

export interface AutoTraceStats {
  /** Files the hook rewrote, and the functions it wrapped in them. */
  files: number;
  fns: number;
  /** Files loaded untouched, by reason (see @hoplens/transform/register HookReport). */
  refused: Record<string, number>;
  /** The first file refused for each reason, with what did not match when the hook says (`unmapped`). */
  firstRefused?: Record<string, { file: string; detail?: string }>;
  /** Files whose transform failed (loaded untouched); the first one is logged. */
  errors: number;
}

const KEY = Symbol.for("hoplens.express.state");

export function adapterState(): AdapterState {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = {
      listenPatched: false,
      inListen: false,
      booting: false,
      failed: false,
      banner: { printed: false, uiReady: false },
    } satisfies AdapterState;
  }
  return g[KEY];
}
