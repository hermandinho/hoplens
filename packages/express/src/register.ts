// `node -r @hoplens/express/register app.js` or `node --import @hoplens/express/register app.js`.
// Checks the gate, then wraps server.listen so the runtime boots right before the app's first server
// binds. Route registration and dispatch are patched now, before user code registers a route (Express
// 4 binds Route#dispatch when a route is created). With the gate off nothing is patched and
// @hoplens/core is never loaded.
//
// Function hops: unless autoTrace is off in the environment (HOPLENS_OPTIONS / HOPLENS_AUTOTRACE),
// the core-free shim goes in first and the transform's ESM hook and CommonJS layer wrap the exported
// functions of the app's own modules as they load (autotrace.ts).
//
// Request path: decided first (pathflag.ts: HOPLENS_PATH=1/0 always wins, else the sticky flag file
// `<stateDir>/path.json` the UI's Enable button or `hoplens init --path` writes; one small file read,
// nothing loaded). When on, V8 block coverage starts before the shim and the hooks, so every app
// module compiles with block counters. Only @hoplens/core/coverage loads for it (one small file,
// node:inspector inside); with the path off nothing of it is loaded.
//
// Main thread only: under `-r` Node also runs this preload inside the module hooks worker.

import { isMainThread } from "node:worker_threads";
import { installShim, readAutoTrace, startFunctionHops } from "./autotrace";
import { shouldStart } from "./gate";
import { pathDecision } from "./pathflag";
import { earlyRoot, installRoutes } from "./routes";
import { install } from "./start";
import { adapterState } from "./state";

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
    let on = false;
    step(() => {
      const d = pathDecision();
      adapterState().path ??= d;
      on = adapterState().path!.on;
    });
    if (on) {
      step(() => {
        (require("@hoplens/core/coverage") as typeof import("@hoplens/core/coverage")).startCoverage();
      });
    }
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
