import { app } from "./app.js";
import { ready } from "./lib/db.js";

const port = Number(process.env.PORT ?? 3100);

// Boot and seed the in-memory database first, so the first request's journey is about the request.
await ready;

app.listen(port, () => {
  console.log(`example-express-app on http://localhost:${port}`);
  // The register hook boots Hoplens right before this listen, so by now it is running or it never will.
  if (globalThis.__hoplens_runtime) console.log(`  Hoplens: http://localhost:${port}/__hoplens`);
  else console.log("  Hoplens is off: `pnpm dev` runs with it (`pnpm start` runs without).");
});
