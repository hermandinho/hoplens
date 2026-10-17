// `node -r @hoplens/express/register app.js` or `node --import @hoplens/express/register app.js`.
// Checks the gate, then wraps server.listen so the runtime boots right before the app's first server
// binds. Route registration and dispatch are patched now, before user code registers a route (Express
// 4 binds Route#dispatch when a route is created). With the gate off nothing is patched and
// @hoplens/core is never loaded.

import { shouldStart } from "./gate";
import { installRoutes } from "./routes";
import { install } from "./start";

try {
  if (shouldStart()) {
    installRoutes();
    install();
  }
} catch {
  /* Hoplens must never break the app */
}
