import type { HoplensOptions, Runtime } from "@hoplens/core";
import { shouldStart } from "./gate";
import { adoptApp, earlyRoot, installRoutes } from "./routes";
import { bootDeferred } from "./start";

/**
 * Start Hoplens for an Express app from code, for when the start command can't take the register
 * hook. Like the hook, the runtime boots right before the app's first `listen`, so it knows the app's
 * port and keeps its UI off it; called after the app already listens, it boots a moment later.
 * Returns the Runtime when it is already running, else undefined (not booted yet, or the gate is off:
 * NODE_ENV=production or test without HOPLENS_FORCE=1, or HOPLENS=0). Safe alongside the register
 * hook: the process boots once.
 *
 * ```js
 * const app = express();
 * hoplens(app);
 * ```
 */
export function hoplens(app?: unknown, opts?: HoplensOptions): Runtime | undefined {
  try {
    if (!shouldStart()) return undefined;
    // Routes registered from here on get templates and registration lines; earlier ones templates.
    if (opts?.enabled !== false) {
      // The app's express resolves from the root boot will use: opts.root, else HOPLENS_OPTIONS / cwd.
      const early = earlyRoot();
      const given = (opts as { root?: unknown } | undefined)?.root;
      const root = typeof given === "string" && given ? given : early;
      if (early !== undefined || opts?.enabled === true) installRoutes(root);
      adoptApp(app);
    }
    return bootDeferred(opts);
  } catch {
    return undefined;
  }
}

export default hoplens;
export type { HoplensOptions, HoplensProfile } from "@hoplens/core";
