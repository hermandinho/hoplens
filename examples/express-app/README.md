# example-express-app

Walkthrough target for the Express adapter. Not part of any published package.

An Express 5 app (plain ESM JavaScript) wired the way users will wire it: `hoplens` as a dev
dependency and the register hook preloaded from the `dev` script.

```bash
pnpm build                                    # once, from the repo root: builds packages/*
pnpm --filter example-express-app dev         # node --watch --import hoplens/express/register src/server.js
# → http://localhost:3100/__hoplens
pnpm --filter example-express-app traffic     # in another terminal
```

`PORT` sets the app port (default 3100), `HOPLENS_PORT` the standalone UI port (default 4983):

```bash
PORT=3101 HOPLENS_PORT=4991 pnpm --filter example-express-app dev
PORT=3101 ROUNDS=10 pnpm --filter example-express-app traffic
```

The same in PowerShell (the variables stay set for the rest of that session):

```powershell
$env:PORT=3101; $env:HOPLENS_PORT=4991; pnpm --filter example-express-app dev
$env:PORT=3101; $env:ROUNDS=10; pnpm --filter example-express-app traffic
```

`pnpm --filter example-express-app start` runs the same app without the register hook, so with no
Hoplens at all.

## Layout

| Path | What |
|---|---|
| `src/server.js` | Waits for the database, then `app.listen(PORT)` |
| `src/app.js` | The express app: middleware, static files, router mounts, 404 and error middleware |
| `src/routes/*.js` | One router per area; each seeded problem is commented at its route |
| `src/services/*.js` | The data access the routes call (`findProduct`, `orderLines`, `dashboardStats`, ...): each exported function is a function hop in Hoplens |
| `src/middleware/*.js` | Request id, the slow auth middleware, the 404 and 4-arg error handlers |
| `src/lib/db.js` | In-memory Postgres: [PGlite](https://pglite.dev) behind a stock `pg.Pool` |
| `public/` | `index.html`, `style.css`, `logo.svg`, served by `express.static` |
| `scripts/traffic.mjs` | Hits every route `ROUNDS` times (default 5) and checks each status |
| `scripts/check-schemas.mjs` | `pnpm --filter example-express-app check:schemas`: starts the app on its own ports (`PORT` 3110, `HOPLENS_PORT` 4990), checks the `OrderBody` schema Hoplens found for `POST /api/orders` and sends its example body (201) |

`src/lib/db.js` is adapted from the Next example: PGlite (Postgres compiled to WASM) runs inside the
process and `pg` talks to it over an in-memory stream, so every query goes through
`pg.Client.prototype.query` and Hoplens records it as a `db` hop with the SQL, the bound params and
the row count. Each round trip waits 2 ms (`EXAMPLE_DB_LATENCY_MS`, `0` turns it off) so an N+1
costs something. The seed (20 users, 30 products, 100 orders with 6 line items each) runs at boot
on PGlite directly and never shows up as queries.

## Seeded problems

| Route | Seeded problem | What Hoplens shows |
|---|---|---|
| `GET /api/health` | none: the healthy, fast baseline (registered before the auth middleware) | a ~1 ms request with just its handler hop and no findings |
| `GET /api/users/:uid/orders/:id` | N+1: a router mounted at `/api/users/:uid` (`mergeParams`) loads the order with `findOrder()`, then `orderLines()` loads its items and calls `productSummary()` (one query) per item | handler hop `GET /api/users/:uid/orders/:id` > `findOrder`, `orderLines` > 6x `productSummary`, each with its query; `n-plus-1` "orderLines ran `select ... from products where id = ?` x6 via productSummary()", located at the loop in `src/services/orders.js`; the loop's calls are not reported again as `parallelizable` |
| `GET /api/dashboard` | three independent queries awaited one after another in `dashboardStats()` | handler hop > `dashboardStats` > 3 queries; `parallelizable` "dashboardStats: 3 sequential calls could run in parallel", located at `src/services/dashboard.js` (only when each query takes >= 10 ms, so not on every request) |
| `GET /api/products/:id` | the handler calls `findProduct()` twice for the same id | handler hop > 2x `findProduct`, each with its query; `duplicate` "... ran x2 via findProduct() with identical params" on the route handler, located at the second `findProduct(id)` call in `src/routes/products.js` |
| `GET /api/report` | a ~2 MB JSON export in one response | `large-payload` (response body 2.1 MB) |
| `POST /api/orders` | `express.json` + a zod schema; the body carries the customer email and a `password` | the request body with the email as sent and `password: "[redacted]"` (the `authorization` header is redacted too); the invalid body in the traffic script answers 400 and counts as a swallowed error |
| `GET /api/flaky` | about 1 request in 3 rejects after a query and reaches the 4-arg error middleware | ~1 in 3 requests 500, counted as thrown errors in the route's error rate |
| `GET /api/boom` | a synchronous throw | every request 500, a thrown error |
| `/api/*` (all but health) | an auth middleware waits ~30 ms before `next()` | ~30 ms of `idle` time before the handler hop starts (middleware hops are not captured yet; `slowAuth`, `requestId` and the error handler are exported functions but get no function hop, see below) |
| `GET /files/*splat` | an Express 5 named wildcard serving a fake file listing | every path grouped under one route, `GET /files/:splat+` |
| `GET /`, `/style.css`, `/logo.svg` | `express.static("public")` | static assets listed under their path (`/` is `index.html`), not as routes |

The first request to each route and each static file after a (re)start also gets an informational
`cold-compile` finding: the rule is shared with the Next adapter, where a first hit compiles the
route; on Express it only marks the first request since the process started. `node --watch` restarts the app when one of its files, or a rebuilt Hoplens package, changes.

## Function hops

The register hook also wraps the exported functions of the app's own modules (everything under `src/`)
as they load, so each call made during a request is a hop with its file and line, nested under the
handler hop, its queries nested inside it. The banner says how many: `function hops: 11 fns in 6 files`.
Calls shaped like Express middleware or handlers (`(req, res, next)`, `(err, req, res, next)`) are not
wrapped, so `requestId`, `slowAuth`, `notFound` and `errorHandler` keep only their route's handler hop.
`HOPLENS_AUTOTRACE=0` (or `HOPLENS_OPTIONS='{"autoTrace":false}'`) turns function hops off.

With function hops on, the `n-plus-1`, `duplicate` and `parallelizable` findings above are owned by the
service function instead of the route handler, so their location and fingerprint differ from a run
without them.
