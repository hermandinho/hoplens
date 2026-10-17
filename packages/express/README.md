# @hoplens/express

[![npm](https://img.shields.io/npm/v/@hoplens/express.svg)](https://www.npmjs.com/package/@hoplens/express)

Express 4 and 5 adapter for [Hoplens](https://github.com/hermandinho/hoplens): a request-journey
view at `/__hoplens` on your app's own port while you develop.

> **Early preview.** Requests, request bodies (redacted), static assets, route templates, handler
> hops and the route list are captured today. Middleware hops come next.

Most users install the meta-package and use its `hoplens/express` entries (pnpm does not hoist
`@hoplens/express` for you):

```bash
npm i -D hoplens
```

## Usage

Preload the register hook. It works with both flags, for CommonJS and ESM apps:

```bash
node -r hoplens/express/register server.js
node --import hoplens/express/register server.mjs
```

Or start it from code:

```js
const express = require("express");
const { hoplens } = require("hoplens/express");

const app = express();
hoplens(app);
```

Call it before `app.listen()`: Hoplens then starts right before your server binds, as the register
hook does. Called later, it starts about 3 seconds after the call. Call it right after `express()`,
before your routes, so their handler hops point at the line that registered them (the register hook
always does).

Then open `http://localhost:<your port>/__hoplens` (also served standalone on
`http://127.0.0.1:4983`).

## Routes and handler hops

Each request is grouped under the full template of the route that answered it, mount prefixes
included: `GET /api/users/7/orders/9` on a router mounted at `/api/users/:uid` is
`/api/users/:uid/orders/:id`. Sub-apps (`app.use("/admin", admin)`), a router mounted at several
prefixes, `app.route()` chains and array paths are resolved too; a regex route shows as written
(`/^\/re\/(\d+)$/`).

Express 5 path syntax is shown in the Express 4 / Next notation (`:x+` one or more segments, `:x*`
zero or more): `/*splat` as `/:splat+`, `{/*rest}` as `/:rest*`, `{/:opt}` as `/:opt?` (`{.json}`
as `(.json)?`).

With `hoplens(app)` called after some routes, mounts made before the call show their prefix from
the request URL, with param values named where the router sees them (`mergeParams`) and id-like
segments as `:id`. On Express 4, routes of a sub-app mounted before the call get no template and
no handler hop: call `hoplens(app)` before mounting sub-apps. A router or sub-app built before the
call (required from its own module) and mounted after it is covered on both majors.

The route's handlers run inside one handler hop, `GET /api/users/:uid/orders/:id`, located at the
line of your code that registered the route. Database calls and other hops made in the handler nest
under it. The hop ends when the response finishes or the route hands on with `next()`;
`next('route')`, `next('router')`, `next(err)`, sync throws and Express 5 rejected promises behave
exactly as without Hoplens. A request no route matched (a 404) has no route and no handler hop.

## Route list

The UI's route list (and the request builder's route picker) comes from your app's router, with no
build step: one entry per full template, the same template the route's requests are grouped under,
with each method at the line of your code that registered it. `app.all()` and `route.all()` are
listed as `ANY`; the `HEAD` and `OPTIONS` answers Express makes on its own are not listed. Sub-apps
and routers mounted under a parameterised path (`/api/users/:uid`) are listed with their full
templates, a router mounted at several prefixes once per prefix.

Routes registered later (while handling a request, say) appear on the next scan, about every 1.5
seconds. A route Hoplens could not reach from your app (under a mount made before `hoplens(app)`)
is listed once a request reached it. With `hoplens(app)`, routes registered before the call are
listed with no file; on Express 5 they show once the app registers another route or takes a request.

The request builder gets each route's path and params, with pattern syntax it cannot send turned
into the shortest path that matches (`/file{.json}` as `/file`, Express 4 `/ab?cd` as `/acd`); a
regex route is listed as written, with no params. Request-body schemas are not read yet: the
builder starts a `POST`/`PUT`/`PATCH` body as `{}` instead of pre-filling it from a Zod schema (as
it does for Next route handlers), so fill the body in before sending.

## When it runs

- On when `NODE_ENV` is unset or `development`.
- Off for `NODE_ENV=production` or `test`, unless `HOPLENS_FORCE=1`.
- Off for `HOPLENS=0`.

With the gate off, the register hook patches nothing and never loads `@hoplens/core`. With it on, the
runtime starts right before your app's first `listen()`; a script that never listens binds no port.

## Options

`hoplens(app, options)` takes the shared `HoplensOptions` (`port`, `redact`, `maxTraces`, `insights`,
`persist`, ...). From the environment:

| Variable | Effect |
|---|---|
| `HOPLENS_PORT` | Standalone UI port (default 4983) |
| `HOPLENS_OPTIONS` | JSON `HoplensOptions`, applied before code options |
| `HOPLENS_IGNORE` | Comma-separated path prefixes never traced, e.g. `/health,/metrics` |

`persist` is on by default here and writes route stats to `node_modules/.cache/hoplens`.
