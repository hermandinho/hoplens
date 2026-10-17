#!/usr/bin/env node
// Generate sample traffic for Hoplens: hits every route of the example N times.
//
//   node scripts/traffic.mjs                 # PORT=3100 (or BASE=...), 5 rounds
//   PORT=3101 ROUNDS=10 node scripts/traffic.mjs                 # POSIX shells
//   $env:PORT=3101; $env:ROUNDS=10; node scripts/traffic.mjs     # PowerShell
//
// Runs requests one at a time so traces don't overlap and timings stay readable. Five rounds give each
// route enough warm requests for findings and per-edit regressions.

const BASE = (process.env.BASE ?? `http://localhost:${process.env.PORT ?? 3100}`).replace(/\/$/, "");
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const AUTH = { authorization: "Bearer dev-token" };

const order = (n) => ({
  customer: { name: `Shopper ${n}`, email: `user${1 + (n % 20)}@example.test` },
  password: "hunter2",
  items: [
    { productId: 1 + (n % 30), qty: 1 },
    { productId: 1 + ((n * 7) % 30), qty: 2 },
  ],
});

const post = (body) => ({
  method: "POST",
  headers: { ...AUTH, "content-type": "application/json" },
  body: JSON.stringify(body),
});

// `expect` is the designed status; /api/flaky is 200 or 500 by design (~1 in 3 fails).
/** @type {(round: number) => { path: string; init?: RequestInit; expect: number[] }[]} */
const requests = (round) => [
  { path: "/", expect: [200] },
  { path: "/style.css", expect: [200] },
  { path: "/logo.svg", expect: [200] },
  { path: "/api/health", expect: [200] },
  // N+1. Order ids belong to user 1 + (id * 7) % 20.
  { path: "/api/users/2/orders", expect: [200] },
  { path: "/api/users/2/orders/3", expect: [200] },
  { path: "/api/users/11/orders/10", expect: [200] },
  { path: "/api/users/16/orders/25", expect: [200] },
  { path: "/api/users/1/orders/3", expect: [404] },
  // Sequential independent queries.
  { path: "/api/dashboard", expect: [200] },
  // Duplicate query.
  { path: "/api/products?limit=5", expect: [200] },
  { path: "/api/products/7", expect: [200] },
  { path: "/api/products/12", expect: [200] },
  { path: "/api/products/999", expect: [404] },
  // Big payload.
  { path: "/api/report", expect: [200] },
  // Body + redaction (and one invalid body for the 400 path).
  { path: "/api/orders", init: post(order(round)), expect: [201] },
  { path: "/api/orders", init: post(order(round + 100)), expect: [201] },
  { path: "/api/orders", init: post({ customer: { name: "", email: "nope" }, items: [] }), expect: [400] },
  // Errors.
  { path: "/api/flaky", expect: [200, 500] },
  { path: "/api/flaky", expect: [200, 500] },
  { path: "/api/flaky", expect: [200, 500] },
  { path: "/api/boom", expect: [500] },
  // Wildcard.
  { path: "/files/docs", expect: [200] },
  { path: "/files/docs/guide.md", expect: [200] },
  { path: "/files/images/logo.svg", expect: [200] },
  { path: "/files/nope/missing.txt", expect: [404] },
];

let unexpected = 0;
let total = 0;
const flaky = { ok: 0, failed: 0 };
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`-- round ${round}/${ROUNDS}`);
  for (const { path, init, expect } of requests(round)) {
    total++;
    const started = performance.now();
    try {
      const res = await fetch(BASE + path, { ...init, headers: { ...AUTH, ...init?.headers } });
      const body = await res.arrayBuffer();
      const ms = Math.round(performance.now() - started);
      const ok = expect.includes(res.status);
      if (!ok) unexpected++;
      if (path === "/api/flaky") flaky[res.status === 200 ? "ok" : "failed"]++;
      console.log(
        `${String(res.status).padEnd(4)} ${String(ms).padStart(6)}ms ${String(body.byteLength).padStart(9)}B  ${init?.method ?? "GET"} ${path}${ok ? "" : `  (expected ${expect.join("/")})`}`,
      );
    } catch (err) {
      unexpected++;
      console.log(`ERR  ${path}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
console.log(`/api/flaky: ${flaky.ok} ok, ${flaky.failed} failed (about 1 in 3 should fail)`);
console.log(`done: ${total} requests, ${unexpected} unexpected statuses/errors. Open ${BASE}/__hoplens`);
process.exitCode = unexpected > 0 ? 1 : 0;
