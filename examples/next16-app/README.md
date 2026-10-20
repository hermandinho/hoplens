# example-next16-app

Walkthrough target for Hoplens. Not part of any published package.

```bash
pnpm install && pnpm build                   # once, from the repo root: builds packages/*
pnpm --filter example-next16-app dev
# → http://localhost:3000/__hoplens
```

Exercises a `proxy.ts`, Zod v4 schemas, outbound `fetch`, a thrown error path, and a `traced()` helper, so every hop kind shows up in the UI.

Wired the way `npx hoplens init` does it in an app: `hoplens` is the only Hoplens package, as a dev dependency (like `npm i -D hoplens`); `next.config.ts` wraps the config with `withHoplens()` from `hoplens/next`, and `src/instrumentation.ts` loads `hoplens/node` in `register()` under `NODE_ENV === "development"`.

![Next 16 journey for GET /api/db/products: Next.js spans folded, proxy, handler, function and db hops, and the N+1 verdict at route.ts:19](../../docs/images/next-journey.png)

## Local routes

No network and no database: in-memory data from `src/lib/store.ts`, with small fixed delays so the hops have some width.

| Route | What it shows |
|---|---|
| `GET /api/products?cat=&limit=` | a `ProductQuery` Zod schema (`src/lib/schemas.ts`) validating the query, then the `listProducts` function hop; a bad query answers 422 |
| `POST /api/orders` | the proxy hop (`src/proxy.ts` answers 401 without `x-api-key: dev-key` on non-GET `/api/orders*`), the `CreateOrder` schema, a `console.log` in the journey, then `createOrder` and `recordOrder`, which calls the non-exported `writeAudit` wrapped with `traced("audit.write", ...)` from `hoplens/trace`; an invalid body answers 400 |
| `GET /api/orders/[id]` | `getOrder`; the seeded order `9c1e7a52-4b0d-4e1a-9a55-1f3c2e8d0b77` answers 200, any other id 404 |
| `PATCH /api/orders/[id]` | the thrown error path: `payOrder` throws "Order already paid" for the seeded order (it is paid), so the route 500s with an empty body and the error and its line live in the journey; needs the `x-api-key` header |
| `POST /api/newsletter` | an inline Zod schema (`email`, `topics`, `consent: true`) for the request builder; an invalid body answers 422 |
| `GET /api/npm/[name]` | one outbound `fetch` to registry.npmjs.org with `cache: "no-store"` (needs internet; answers 502 when npm does not answer 200) |

Every route under `/api/*` passes through `src/proxy.ts`, which adds an `x-request-id` header.

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

The first `/api/db/*` request boots and seeds the database (a few seconds, up to ~20s on a cold Windows machine; the seed runs on PGlite directly, so it doesn't show up as queries). The data is deterministic and in memory only: 8 categories, 40 products, 50 users, 300 orders with ~900 line items, and 200k reviews.

| Route | Finding | Compare with |
|---|---|---|
| `GET /api/db/products` | `n-plus-1` (one page of products, then one review-stats `SELECT ... WHERE product_id = $1` per row) | `?fast=1` (one query: CTE + `LATERAL` join), `?limit=N` (1..40) |
| `GET /api/db/orders/[id]` | `duplicate` (the order row is loaded twice with the same SQL and params) | any id in 1..300; others return 404 |
| `GET /api/db/search?q=` | slow query (`ILIKE '%q%'` count over 200k reviews, a full sequential scan every time) | `?q=warranty&limit=5` |

`pg` is on Next's built-in server-external list; `@electric-sql/pglite` is added to `serverExternalPackages` in `next.config.ts` because it loads its WASM files from its own package directory.

Query params are validated with Zod schemas in `src/lib/schemas.ts`, which Hoplens reads to prefill the request builder.

## Compare before and after an edit

`next dev` hot-reloads in the same process, so the traces from before an edit stay in memory next to the ones after it. Request `GET /api/db/products?limit=8`, fix the N+1 in `src/app/api/db/products/route.ts`, request it again, open the new trace and press `c`: it opens the default baseline (the request from the previous build, else the previous request to the same URL). `d` diffs against the previous build, `c c` picks the baseline from the list (a `?fast=1` trace, say, without editing anything), and the edit's row in the Changes view has a **compare before / after** button:

![Compare view of GET /api/db/products?limit=8 before and after an edit that removed the N+1: B is 74ms faster (-40%), time by bucket, the N+1 finding resolved, spans only in A and only in B](../../docs/images/compare.png)

## Request path

The request path works under `next dev` too (Turbopack and `--webpack`). Turn it on with **Enable request path** in the Path view (press `x` on a GET request), `npx hoplens init --path`, or `HOPLENS_PATH=1`; the flag lives in `.next/cache/hoplens/path.json` and is read when the instrumentation hook loads, so restart `next dev` after enabling it. Then **Trace path** replays the GET once and shows which branches each function took.

## Generate sample traffic

With the dev server running:

```bash
pnpm --filter example-next16-app traffic
# or, against another port / more rounds:
BASE=http://localhost:3001 ROUNDS=10 node examples/next16-app/scripts/traffic.mjs
```

It hits every demo route and variant (plus the local routes, except `PATCH /api/orders/[id]` and `POST /api/newsletter`) `ROUNDS` times, one request at a time, and prints status, time and size for each. Then open `/__hoplens`. The public-API routes and `/api/npm/[name]` need internet access (the `/api/db` ones don't); `/api/flaky` returns 200 even when its upstream fails, by design.
