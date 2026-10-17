// `node -r @hoplens/express/register app.js` or `node --import @hoplens/express/register app.js`.
// Checks the gate, then wraps server.listen so the runtime boots right before the app's first server
// binds. With the gate off nothing is patched and @hoplens/core is never loaded.

import { shouldStart } from "./gate";
import { install } from "./start";

try {
  if (shouldStart()) install();
} catch {
  /* Hoplens must never break the app */
}
