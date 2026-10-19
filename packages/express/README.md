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

The quickest setup is the CLI, which adds the register hook to your `dev` script and nothing else:

```bash
npx hoplens init        # "dev": "node --watch src/server.js" -> "node --watch --import hoplens/express/register src/server.js"
npx hoplens doctor      # checks the install and wiring
npx hoplens remove      # puts the script back as it was and deletes node_modules/.cache/hoplens
```

`init` edits `scripts.dev` (or `start:dev`, or `watch`), never `start` and never your code. It
handles `node [--watch]`, `tsx [watch]` and `nodemon` (as `nodemon --exec "node --import
hoplens/express/register"`), with env prefixes such as `cross-env NODE_ENV=development` and `&&`
chains kept as written. For other runners (`ts-node-dev`, `pm2`, `docker`, ...) it prints the line to
use instead. `--dry-run` shows the change first.

Or preload the register hook yourself. It works with both flags, for CommonJS and ESM apps:

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

## Function hops

The register hook also wraps the exported functions of your own modules (ES modules and CommonJS)
as they load, so each call made while a request runs is a hop named after the function, at its file and line, nested under
the handler hop (and under the function that called it). The banner counts them:
`function hops: 11 fns in 6 files`.

- Scope: everything under `src/`, or without `src/` the usual dirs (`routes/`, `controllers/`,
  `services/`, `lib/`, ...). `node_modules`, `dist/`, `build/`, `out/`, `*.d.ts`, tests and
  `*.config.*` files are left out. `HOPLENS_OPTIONS='{"autoTrace":{"include":["lib/**"]}}'` replaces
  the scope, `exclude` narrows it. Build output comes in only through an include that names its dir
  (`"include":["dist/**"]` for tsc output run with `node dist/server.js`).
- Wrapped: `export function f`, `export const f = () => ...` / `function () {}`, and `export { f }` /
  `export { f as g }` of a top-level function. Default exports, classes and generators are not.
- CommonJS: `exports.f = f`, `exports.f = function () {}` / `() => {}`, `module.exports.f = ...`,
  `module.exports = { f, g: function () {}, h() {} }`, `Object.defineProperty(exports, "f", { value, writable: true })`
  and tsc's output (`exports.f = void 0; ... exports.f = f`). The *exports property* is rebound once the
  module ran, and only when it is still a writable data property holding a function: getter exports
  (tsc re-exports, esbuild's `__export`), frozen and non-writable exports load as they are, and
  `module.exports = f` itself is never wrapped. A call through the module's own local binding
  (`f()` inside the file) stays unwrapped; `module.exports.f()` / `exports.f()` goes through the hop.
- Left unwrapped so the app behaves exactly as without Hoplens: a function the module itself uses as
  a value (`bus.on('x', f)`, `{ f }`, `export default f`, `new f()`), a function that uses `this`
  (constructor style), and a function that calls itself (recursion would go through the wrapper at
  every level). Files over 1 MB load untouched, as generated code. A wrapped function still returns
  the very promise it made when the app put something on it (`p.cancel = ...`).
- In a request at most 1000 function hops are recorded; later calls run unwrapped and count as
  dropped spans. While function hops are on, Node's default `Error.stackTraceLimit` of 10 is raised
  to 40 so the wrapper frames do not push your callers out of a stack trace.
- Calls shaped like Express middleware or handlers, `(req, res[, next])` or `(err, req, res, next)`,
  are not wrapped: they keep only their route's handler hop. A helper you call as `f(req, res)` is
  skipped too; wrap it with `traced()` from `hoplens/trace` if you want it.
- Lines and columns never move, so stack traces and breakpoints land where they did.
- Runners:

  | Command | ES modules | CommonJS |
  |---|---|---|
  | `node [--watch] --import hoplens/express/register src/server.js` (`.js`, `.mjs`, `.cjs`) | yes | yes, except the entry file itself (see below) |
  | the same with `.ts` / `.cts` that Node strips itself (Node 22.18+, or 22.6+ with `--experimental-strip-types`) | yes | yes, entry included (Node hands the ESM hook the file as it is on disk) |
  | `node -r hoplens/express/register ...` | yes | yes, entry included |
  | `node --import hoplens/express/register --import tsx src/server.ts` | yes: Hoplens sees the raw `.ts` | yes |
  | `tsx [watch] --import hoplens/express/register src/server.ts` (what `hoplens init` writes) | yes: tsx's compiled output is mapped back to the `.ts` file | yes |
  | `node --import tsx --import hoplens/express/register src/server.ts`, `node -r hoplens/express/register --import tsx ...` | yes, as above | yes |
  | `node -r ts-node/register -r hoplens/express/register src/server.ts` (either `-r` order) | - | yes (tested with ts-node 10.9.2), type-checking mode included (a `// @ts-ignore` line goes before the appended line) |
  | `node dist/server.js` (tsc output) | with `autoTrace.include: ["dist/**"]` | with `autoTrace.include: ["dist/**"]` |

  CommonJS files are rewritten before the loader compiles them (Node, tsx or ts-node): while
  `require()` loads one of your files, Hoplens hands that loader the file's source plus a few lines
  appended at the end, through `fs.readFileSync` for that one file only and only until the loader
  compiles it; every other read sees the disk. Hoplens stays the outermost loader even when tsx or
  ts-node register after it. Two cases load untouched, named in the banner: a CommonJS entry run
  with `--import` (Node reads it through its ESM loader; the modules it requires are wrapped; use
  `-r hoplens/express/register` to wrap the entry too, and `hoplens doctor` points it out), and a
  CommonJS file imported from an ES module.

  The wrapper replaces the `exports` property after the module ran, so a few things keep the
  original function: calls through the module's own local name, a function that calls itself
  through its own export (`exports.f(n - 1)`; skipped, so recursion depth stays the same), and a
  module in a `require` cycle that read the export while its partner was still loading (everyone
  who requires it afterwards gets the wrapper, so `on(a.f)` there and `off(a.f)` later do not
  match). One function exported under several names gets one wrapper.

  When tsx compiles a file first, Hoplens finds each exported function in tsx's output by its export
  name and only appends code after it, so tsx's source map, stack traces and breakpoints are
  unchanged and hops carry the line in your `.ts` file. The same check applies whichever loader
  compiled the file: a file whose compiled output does not map back to the `.ts` file with certainty
  (a top-level `using`, lowered `async`, another loader's rewrites) loads untouched, and the banner
  names it in one line; loading Hoplens before the loader wraps it.
- Off with `HOPLENS_AUTOTRACE=0` or `HOPLENS_OPTIONS='{"autoTrace":false}'`: nothing is wrapped, no
  TypeScript is loaded, and `Module._extensions` and `fs.readFileSync` stay Node's own. `autoTrace` given to `hoplens(app, opts)` comes after your modules loaded,
  so it only stops function hops from binding (and says so).
- Findings an exported function owns (an N+1 in a service, a duplicate query) are located at that
  function and fingerprinted under its name, so they differ from a run without function hops.

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
regex route is listed as written, with no params.

### Zod schemas

The builder pre-fills a route's body from the Zod schema its handlers use, as it does for Next
route handlers. Schemas (body, query, params) are read statically from the file and line that
registered the route (your code is never run for this), at most one per part, handlers first:

1. **Handlers.** `Schema.parse(req.body)` (or `safeParse`, `parseAsync`, `safeParseAsync`), also on
   `req.query` and `req.params`, in an inline handler or in one referenced by name: a function in
   the same file, an import (ESM `import` or CommonJS `require`, through re-exports and barrels), a
   namespace or object member (`orders.create`, `ctrl.items.create`), a class method
   (`new OrderController()`'s `ctrl.create`, a static `OrderController.make`,
   `ctrl.create.bind(ctrl)`), or one wrapped in a call (`asyncHandler(createOrder)`). A handler that
   only forwards the request (`(req, res) => ctrl.create(req, res)`, `(req, res, next) =>
   create(req, res, next)`, `async (req, res) => { await service.create(req, res); }`,
   `function (req, res) { return create(req, res); }`, also with `.catch(next)`) is followed into
   the function it calls, two levels deep. The schema itself may live in another file; a member
   (`schemas.OrderBody`, `ns.OrderBody` of `import * as ns`, `S.OrderBody` of a `require`) is
   located where it is declared.
2. **Validation middleware** in the registration's arguments, by shape rather than by library: a
   call with a single Zod schema argument (`validate(OrderBody)`, `validateBody(OrderBody)`; a
   function name containing `query`, `param` or `form` targets that part, anything else the body);
   a call with a part name and a schema (`zValidator("json", OrderBody)`, `validate(Q, "query")`);
   or a call with `{ body, query, params }` schemas (`validate({ body: OrderBody })`). A name bound
   to such a call (`const checkOrder = validate(OrderBody)`) works too.

Routes registered in a loop share one call site. Hoplens reads the route table the loop walks and
picks the element whose path (and, for `router[r.method]`, method) is the route's, then reads that
element's handlers and middleware as above. Supported shapes:

```js
for (const r of routes) router[r.method](r.path, ...r.middleware, r.handler);
for (const { path, handler } of routes) app.post(path, handler);
routes.forEach((r) => app.get(r.path, r.handler));
for (const [path, handler] of Object.entries(handlers)) app.post(path, handler);
```

The table must be an array or object literal (spreads of other literals are followed), in the same
file or a `const` imported from another one, with each element's path a string (or regex) literal
or a `const` naming one. A table built at runtime (`.map()`, a function's result), a path computed in
the call (`"/v1" + r.path`), or two elements with the same path and method give no schema rather than
another route's.

Not read: schemas built at runtime or imported from a package, parse calls in functions the handler
calls other than by forwarding the request, methods reached through `this`, and non-Zod validators
(`celebrate`/Joi, `express-validator`). The result is cached until the registration file or a file
the lookup read changes.

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
| `HOPLENS_AUTOTRACE` | `0` turns function hops off (read when the register hook loads) |
| `HOPLENS_PATH` | `1` starts V8 block coverage at boot for Trace path (read by the register hook only; restart to change it; refused under `NODE_V8_COVERAGE`) |

`persist` is on by default here and writes route stats to `node_modules/.cache/hoplens`.

## Trace path (request path)

With `HOPLENS_PATH=1` the register hook starts V8 block coverage before your app loads, and the
banner says `request path: on`. `POST /__hoplens/api/traces/:id/path` then replays that trace once,
alone, as a **new** trace, and reports which handler and function code it ran, block by block.
Unset, nothing of it loads.

- GET and HEAD only: replaying anything else would run its side effects again (400 `method`).
- It waits for the app to be idle first. A request still in flight after 3s gives 409 `not-quiet`
  and nothing is sent; one capture runs at a time (409 `busy`).
- Other work inside the capture window (another request, a timer calling the same code) makes it
  retry once, then the capture is kept as `contaminated` with every decision unknown.
- Coverage makes CPU-heavy code slower; under `NODE_V8_COVERAGE` (c8) it stays off
  (`disabled-c8`), and if another inspector session (DevTools' Coverage panel) stops precise
  coverage, Trace path turns off until you restart.
- Each function's decisions come with it: every `if` / `else if` / `else`, `switch` case, `?:`,
  `&&` / `||` / `??` that guards a call (or is the value returned), `try` / `catch`, the loops'
  passes and where the function exited, plus a verdict line for the request (`Exited: return at
  GET /api/products/:id L21 via if !(await findProduct(id)) -> then`). An arm reads **taken**
  only when it really ran; anything the counts cannot prove (code after a callee threw, an await
  still pending at capture, a file edited since the app started, compiled TypeScript) is
  **unknown** with the reason. A function
  called more than once shows totals, marked blended.

## Changes across restarts

`node --watch`, `tsx watch` and nodemon restart your app on every save, so Hoplens finds the edit
when the new process starts: it hashes your source files (top-level files plus `src/`, or without
`src/` the usual dirs: `routes/`, `controllers/`, `middleware/`, `models/`, `services/`, `lib/`, ...;
`node_modules`, dot dirs, tests and the simple names in `.gitignore` are left out) and compares them
with the manifest the previous process left in `node_modules/.cache/hoplens/sources.manifest`. A restart
that changed code is a new edit in the Changes view, named after the files it changed, with the
routes whose registration files import them and, once both sides have traffic, each route's
before / after verdict. The first request on each route after a restart is cold.

Formatting is not an edit: whitespace, line breaks, comments, quote style, semicolons and trailing
commas are ignored (JS, TS and JSON are compared token by token; a line break that changes what the
code does, like `return` on its own line, still counts), so a format-on-save, a `touch` or a manual
restart with no change keeps the current edit going. A `.json` file under your source dirs that no
module imports (a store your app writes itself) is not an edit either. An edit to middleware that
`app.js` mounts lists every route of the routers `app.js` mounts. Stats are written to disk every 250ms,
since a watcher stops the old process without warning.

The standalone UI keeps its port across restarts: when the previous process still holds it, the new
one waits up to a second for it before trying the next port.

This needs `persist`. With `persist: false` there is no manifest: every start is one epoch and the
banner says so.
