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

![Trace of GET /api/users/11/orders/10 in Flame mode: the N+1 verdict at orders.js:28, the source peek, the budget bar, Where to look, and the request list](../../docs/images/hero-journey.png)

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

At startup the banner prints the UI URL, how many functions it wrapped and, when it is on, the
request path:

![Startup banner: the Hoplens URL, 'request path: on (flag; disable in the Path view, press x on a request)' and 'function hops: 11 fns in 6 files'](../../docs/images/terminal-startup-banner.png)

Persistence is on by default for Express: stats, the source manifest, the transform cache and the
request path flag live in `node_modules/.cache/hoplens`. A second copy of the app that should not
share that state needs its own directory, e.g. `HOPLENS_OPTIONS='{"stateDir":"/tmp/hoplens-copy"}'`.

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
| `GET /api/products/:id` | the handler calls `findProduct()` twice for the same id | handler hop > 2x `findProduct`, each with its query; `duplicate` "... ran x2 via findProduct() with identical params", located at the second `findProduct(id)` call in `src/routes/products.js` |
| `GET /api/report` | a ~2 MB JSON export in one response | `large-payload` (response body 2.1 MB) |
| `POST /api/orders` | `express.json` + a zod schema; the body carries the customer email and a `password` | the request body with the email as sent and `password: "[redacted]"` (the `authorization` header is redacted too); the invalid body in the traffic script answers 400 and counts as a swallowed error |
| `GET /api/flaky` | about 1 request in 3 rejects after a query and reaches the 4-arg error middleware | ~1 in 3 requests 500, counted as thrown errors in the route's error rate |
| `GET /api/boom` | a synchronous throw | every request 500, a thrown error, with the source-mapped stack |
| `/api/*` (all but health) | an auth middleware waits ~30 ms before `next()` | ~30 ms of `idle` time before the handler hop starts (there are no middleware hops yet; `slowAuth`, `requestId` and the error handlers are wrapped, but their calls pass through unrecorded, see [Function hops](#function-hops)) |
| `GET /files/*splat` | an Express 5 named wildcard serving a fake file listing | every path grouped under one route, `GET /files/:splat+` |
| `GET /`, `/style.css`, `/logo.svg` | `express.static("public")` | static assets listed under their path (`/` is `index.html`), not as routes |

The traffic script also hits `GET /api/users/:uid/orders` and `GET /api/products?limit=5` (one query
each, nothing seeded) and a few 404s (`/api/users/1/orders/3`, `/api/products/999`,
`/files/nope/missing.txt`). An order id only answers under its own user: `/api/users/11/orders/10`
is one the traffic script uses, `/api/users/7/orders/9` is a 404.

The first request to each route and each static file after a (re)start also gets an informational
`cold-compile` finding: the rule is shared with the Next adapter, where a first hit compiles the
route; on Express it only marks the first request since the process started. `node --watch` restarts
the app when one of its files, or a rebuilt Hoplens package, changes.

### What each problem looks like

After one `traffic` run the overview (`#/`) leads with the top problem and ranks the findings across
requests, next to each route's time and the errors line (thrown vs swallowed):

![Overview: the top-problem sentence (N+1), ranked findings, routes by time with n/p50/p95, and the errors line](../../docs/images/overview.png)

The N+1 under `GET /api/users/:uid/orders/:id` is the trace at the top of this file. Its query shape
in the Queries view (`#/queries`, then the shape) shows the same loop across all requests: the calls,
the requests they came from, the x6 loop badge and the caller, `productSummary` at `products.js:15`:

![Queries view for 'select id, name, category from products where id = ?': 90 calls from 15 requests, p95, the x6 loop badge, the caller and sample requests](../../docs/images/queries.png)

The duplicate on `GET /api/products/:id`, in Tree mode (`t`) with the second `findProduct` selected:
the duplicate finding in Where to look, and the Span tab with the function's file:line, its
arguments and its return value:

![GET /api/products/7 in Tree mode with the second findProduct selected: the duplicate finding and the Span tab with location products.js:9, args [7] and the return value](../../docs/images/tree-function-hops.png)

`GET /api/boom` with the handler span selected: the failed verdict with a source peek at the throwing
line (`failures.js:19`) and the source-mapped stack in the Span tab (`o` opens the same line in the
source modal, without the stack):

![GET /api/boom 500: the failed verdict, the source peek at failures.js:19, and the mapped stack](../../docs/images/error-line.png)

The request builder (`b`) for `POST /api/orders` pre-fills the body from the `OrderBody` Zod schema
registered with the route, with each field's type and limits beside it:

![Request builder for POST /api/orders with the body pre-filled from the OrderBody schema and the field list](../../docs/images/request-builder.png)

## Function hops

The register hook also wraps the exported functions of the app's own modules (everything under `src/`)
as they load, so each call made during a request is a hop with its file and line, nested under the
handler hop, its queries nested inside it. The banner says how many: `function hops: 11 fns in 6 files`,
the 7 service functions plus `requestId`, `slowAuth`, `notFound` and `errorHandler` (`src/lib/db.js`
exports no functions).

The four middleware functions are wrapped like the others, but a call shaped like Express middleware
or a handler (`(req, res[, next])`, `(err, req, res, next)`) passes through the wrapper without
being recorded, so those calls keep only their route's handler hop. `HOPLENS_AUTOTRACE=0` (or
`HOPLENS_OPTIONS='{"autoTrace":false}'`) turns function hops off.

With function hops on, the `n-plus-1`, `duplicate` and `parallelizable` findings above are owned by the
service function instead of the route handler, so their location and fingerprint differ from a run
without them.

## Request path

The request path is off by default. Press `x` on a GET trace (the Path view in the Journey pane) and
click **Enable request path**: Hoplens writes `node_modules/.cache/hoplens/path.json` and asks for a
restart, since coverage has to start before the app loads. Saving any file under `src/` restarts
`node --watch`. `HOPLENS_PATH=1` turns it on for one run instead, and wins over the flag.

![Journey card after Enable request path: 'Request path: on at next start', 'Restart your dev server to apply', and Undo](../../docs/images/path-enable.png)

After the restart, open `GET /api/products/999`, press `x`, then **Trace path**. Hoplens replays the
request once as a new trace and shows which code it ran, decision by decision, with a verdict for the
request: `Exited: return at GET /api/products/:id L21 via if !(await findProduct(id)) -> then` (the
404 branch).

![Path trace of GET /api/products/999: the path badge, EXACT, the exit verdict, and the handler and findProduct lanes with decision chips](../../docs/images/path-trail.png)

Click a lane (window 1100px or wider) for that function's Flow chart beside the trail: the taken arm
solid, the arms that did not run dashed or folded, and the evidence footer. `v` switches to the
Source gutter with per-line hit counts.

![Flow chart of the handler: the taken 'then' arm solid, 'else 0' dashed, '2 lines not run' folded, and the evidence footer](../../docs/images/path-flow.png)

![Source gutter of the same function: per-line hit counts, the '-> then' and exit chips, and '2 lines not run (L23-24)'](../../docs/images/path-source.png)

## Changes across restarts

Since persistence is on, each `node --watch` restart that changed code is an edit in the Changes view
(`#/changes`), named after the files it changed, with a before / after verdict per route once both
sides have traffic. To see it: run `traffic`, add `await new Promise((r) => setTimeout(r, 40));` to
`dashboardStats()` in `src/services/dashboard.js`, save (the app restarts), and run `traffic` again, with the default `ROUNDS=5` (a route needs at
least 3 warm requests on each side for a verdict, and the first request after a restart is cold):

![Changes view after the edit: 'saved, app restarted', GET /api/dashboard p50 81ms -> 134ms (+66%), your code +46ms, low confidence](../../docs/images/changes-restart.png)

Traces live in memory, so the restart drops the "before" traces and the edit row's **compare before /
after** button stays disabled here (the Next example's hot reload keeps both sides in one process).
A formatting-only save (whitespace, comments, quotes, semicolons) is not an edit.
