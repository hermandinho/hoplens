#!/usr/bin/env node
// Proves the request builder's prefill for POST /api/orders: starts the example with the register
// hook on its own ports, reads the route list Hoplens serves, checks the body schema it found for
// POST /api/orders (OrderBody, read statically from src/routes/orders.js) and sends that schema's
// example body, which must answer 201. Stops the app it started, and only that.
//
//   pnpm --filter example-express-app check:schemas      # PORT=3110, HOPLENS_PORT=4990
//   PORT=3111 HOPLENS_PORT=4991 node scripts/check-schemas.mjs
//
// Needs the packages built once (`pnpm build` from the repo root).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 3110);
const HOPLENS_PORT = Number(process.env.HOPLENS_PORT ?? 4990);
const BASE = `http://127.0.0.1:${PORT}`;
const root = fileURLToPath(new URL("..", import.meta.url));

const env = { ...process.env, PORT: String(PORT), HOPLENS_PORT: String(HOPLENS_PORT), EXAMPLE_DB_LATENCY_MS: "0" };
for (const k of ["NODE_ENV", "NODE_OPTIONS", "HOPLENS", "HOPLENS_OPTIONS"]) delete env[k];

const app = spawn(process.execPath, ["--import", "hoplens/express/register", "src/server.js"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
app.stdout.on("data", (c) => {
  output += c;
});
app.stderr.on("data", (c) => {
  output += c;
});
const exited = new Promise((resolve) => app.once("exit", resolve));

function fail(message) {
  throw new Error(`${message}\n--- app output ---\n${output}`);
}

async function waitForRoutes(timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (app.exitCode !== null) fail(`the app exited (${app.exitCode})`);
    try {
      const res = await fetch(`${BASE}/__hoplens/api/routes?fresh`);
      if (res.ok) {
        const d = await res.json();
        if (d.routes?.length) return d;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail("timed out waiting for /__hoplens/api/routes");
}

try {
  const d = await waitForRoutes();
  const route = d.routes.find((r) => r.nextRoute === "/api/orders");
  if (!route) fail("POST /api/orders is not in the route list");
  const post = route.methods.find((m) => m.method === "POST");
  const body = post?.schemas.find((s) => s.target === "body");
  if (!body) fail(`no body schema for POST /api/orders: ${JSON.stringify(post)}`);
  if (body.name !== "OrderBody" || body.file !== "src/routes/orders.js")
    fail(`unexpected schema ${body.name} at ${body.file}:${body.line}`);
  const fields = body.fields.map((f) => f.path);
  for (const f of ["customer.name", "customer.email", "items", "items[].productId", "items[].qty"])
    if (!fields.includes(f)) fail(`field ${f} missing from ${fields.join(", ")}`);

  const res = await fetch(`${BASE}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dev-token" },
    body: JSON.stringify(body.example),
  });
  const answer = await res.text();
  if (res.status !== 201)
    fail(`the prefilled body answered ${res.status}: ${answer}\nbody: ${JSON.stringify(body.example)}`);
  console.log(`ok  POST /api/orders: ${body.name} (${body.file}:${body.line}) prefill -> 201 ${answer}`);
  console.log(`    body: ${JSON.stringify(body.example)}`);
} finally {
  if (app.exitCode === null && app.signalCode === null) app.kill();
  await exited;
}
