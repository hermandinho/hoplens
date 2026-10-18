// `node -r @hoplens/express/register app.js` or `node --import @hoplens/express/register app.js`.
// Checks the gate, then wraps server.listen so the runtime boots right before the app's first server
// binds. Route registration and dispatch are patched now, before user code registers a route (Express
// 4 binds Route#dispatch when a route is created). With the gate off nothing is patched and
// @hoplens/core is never loaded.
//
// Function hops: unless autoTrace is off in the environment (HOPLENS_OPTIONS / HOPLENS_AUTOTRACE),
// the core-free shim goes in first and the transform's ESM hook wraps the exported functions of the
// app's own modules as they load (autotrace.ts).
//
// Main thread only: under `-r` Node also runs this preload inside the module hooks worker.

import { isMainThread } from "node:worker_threads";
import { installShim, readAutoTrace, startFunctionHops } from "./autotrace";
import { shouldStart } from "./gate";
import { earlyRoot, installRoutes } from "./routes";
import { install } from "./start";

/** Each step on its own: one failing never stops the next, and none breaks the app. */
function step(fn: () => void): void {
  try {
    fn();
  } catch {
    /* Hoplens must never break the app */
  }
}

try {
  if (isMainThread && shouldStart()) {
    const auto = readAutoTrace();
    if (auto.on) {
      step(() => {
        installShim();
        startFunctionHops(auto, earlyRoot());
      });
    }
    step(() => installRoutes());
    step(() => install());
  }
} catch {
  /* Hoplens must never break the app */
}
