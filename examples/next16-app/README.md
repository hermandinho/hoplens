# example-next16-app

Walkthrough target for Hoplens. Not part of any published package.

```bash
pnpm --filter example-next16-app dev
# → http://localhost:3000/__hoplens
```

Exercises a `proxy.ts`, Zod v4 schemas, outbound `fetch`, a thrown error path, and a `traced()` helper, so every hop kind shows up in the UI.

## Public-API demo routes

These routes call free, no-auth public APIs so Hoplens has realistic, varied traffic to analyze. Each one is built to trigger a specific finding; most have a "fixed" variant so you can compare the two traces side by side. Client code lives in `src/lib/external.ts` and `src/lib/reports.ts` as exported functions, so each call shows up as a function hop.

| Route | Finding | APIs | Compare with |
|---|---|---|---|
| `GET /api/feed` | `n-plus-1` (one author fetch per post, sequential) | jsonplaceholder.typicode.com | `?fast=1` (one batched users call) |
| `GET /api/dashboard` | `parallelizable` (weather, FX, holidays awaited one by one) | geocoding-api.open-meteo.com, api.open-meteo.com, api.frankfurter.dev, date.nager.at | `?parallel=1` (Promise.all) |
| `GET /api/catalog` | `duplicate` (category list fetched twice), `fetch-uncached` (FX quote with `cache: "no-store"`) | dummyjson.com, api.frankfurter.dev | `?category=laptops&currency=USD` (USD skips the FX fetch) |
| `GET /api/pokemon/[name]` | fetch cache contrast (`next: { revalidate: 60 }`) | pokeapi.co | `?cache=0` (no-store, ~300KB upstream every time) |
| `GET /api/report` | `slow-fn` (CPU-bound `crunchStats`), `logs-on-success` (console.warn on 200) | dummyjson.com | `?big=1` (>1MB response, `large-payload`), `?rounds=N` |
| `GET /api/flaky` | `swallowed-error` (upstream 503/timeout recorded on `fetchInventory`, route still 200) | dummyjson.com/http/503, httpbin.org/delay | `?mode=ok\|fail\|timeout\|random` |

`cold-compile` shows up on the first hit of any route after `next dev` starts or after you edit a file.

## Database demo routes

These give the Queries view real SQL to work with, without a database server or docker. `src/lib/db.ts` boots [PGlite](https://pglite.dev) (Postgres compiled to WASM) inside the Next process and connects the stock `pg` client to it through an in-memory stream, so every query goes through `pg.Client.prototype.query` and Hoplens records it as a `db` hop with the SQL, the bound params and the row count, exactly as it would against a remote Postgres.

The first `/api/db/*` request boots and seeds the database (about 3 to 4 seconds; the seed runs on PGlite directly, so it doesn't show up as queries). The data is deterministic and in memory only: 8 categories, 40 products, 50 users, 300 orders with ~900 line items, and 200k reviews.

| Route | Finding | Compare with |
|---|---|---|
| `GET /api/db/products` | `n-plus-1` (one page of products, then one review-stats `SELECT ... WHERE product_id = $1` per row) | `?fast=1` (one query: CTE + `LATERAL` join), `?limit=N` (1..40) |
| `GET /api/db/orders/[id]` | `duplicate` (the order row is loaded twice with the same SQL and params) | any id in 1..300; others return 404 |
| `GET /api/db/search?q=` | slow query (`ILIKE '%q%'` count over 200k reviews, a full sequential scan every time) | `?q=warranty&limit=5` |

`pg` is on Next's built-in server-external list; `@electric-sql/pglite` is added to `serverExternalPackages` in `next.config.ts` because it loads its WASM files from its own package directory.

Query params are validated with Zod schemas in `src/lib/schemas.ts`, which Hoplens reads to prefill the request builder.

## Generate sample traffic

With the dev server running:

```bash
pnpm --filter example-next16-app traffic
# or, against another port / more rounds:
BASE=http://localhost:3100 ROUNDS=10 node examples/next16-app/scripts/traffic.mjs
```

It hits every demo route and variant (plus the original local routes) `ROUNDS` times, one request at a time, and prints status, time and size for each. Then open `/__hoplens`. The public-API routes need internet access (the `/api/db` ones don't); `/api/flaky` returns 200 even when its upstream fails, by design.
