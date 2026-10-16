#!/usr/bin/env node
// Generate sample traffic for Hoplens: hits every demo route (and its variants) N times.
//
//   node scripts/traffic.mjs                 # BASE=http://localhost:3000, 3 rounds
//   BASE=http://localhost:3100 ROUNDS=10 node scripts/traffic.mjs
//
// Runs requests one at a time so traces don't overlap and timings stay readable.

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");
const ROUNDS = Number(process.env.ROUNDS ?? 3);

const ORDER = {
  productId: "3f2b8c1e-7a4d-4c2b-9e1f-5d6a7b8c9d0e",
  qty: 1,
  shipping: { method: "standard", address: { line1: "1 Main Street", city: "Montreal", country: "CA" } },
};

/** @type {{ path: string; init?: RequestInit }[]} */
const REQUESTS = [
  // Public-API demos (one per finding, plus the "fixed" variant to compare).
  { path: "/api/feed" },
  { path: "/api/feed?fast=1" },
  { path: "/api/dashboard" },
  { path: "/api/dashboard?parallel=1" },
  { path: "/api/dashboard?city=Tokyo&currency=JPY" },
  { path: "/api/catalog" },
  { path: "/api/catalog?category=laptops&currency=USD" },
  { path: "/api/pokemon/pikachu" },
  { path: "/api/pokemon/pikachu?cache=0" },
  { path: "/api/pokemon/bulbasaur" },
  { path: "/api/report" },
  { path: "/api/report?big=1" },
  { path: "/api/flaky" },
  { path: "/api/flaky?mode=fail" },
  { path: "/api/flaky?mode=timeout" },
  // Database demos (in-process Postgres via PGlite + pg; no internet needed).
  { path: "/api/db/products" },
  { path: "/api/db/products?fast=1" },
  { path: "/api/db/orders/42" },
  { path: "/api/db/search?q=battery" },
  { path: "/api/db/search?q=warranty&limit=5" },
  // The original local routes.
  { path: "/api/products?cat=hats&limit=5" },
  { path: "/api/npm/next" },
  {
    path: "/api/orders",
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "dev-key" },
      body: JSON.stringify(ORDER),
    },
  },
  { path: "/api/orders/9c1e7a52-4b0d-4e1a-9a55-1f3c2e8d0b77" },
];

let failures = 0;
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`-- round ${round}/${ROUNDS}`);
  for (const { path, init } of REQUESTS) {
    const started = performance.now();
    try {
      const res = await fetch(BASE + path, init);
      const body = await res.arrayBuffer();
      const ms = Math.round(performance.now() - started);
      if (!res.ok) failures++;
      console.log(
        `${String(res.status).padEnd(4)} ${String(ms).padStart(6)}ms ${String(body.byteLength).padStart(9)}B  ${init?.method ?? "GET"} ${path}`,
      );
    } catch (err) {
      failures++;
      console.log(`ERR  ${path}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
console.log(`done: ${ROUNDS * REQUESTS.length} requests, ${failures} non-2xx/errors. Open ${BASE}/__hoplens`);
process.exitCode = failures > 0 ? 1 : 0;
