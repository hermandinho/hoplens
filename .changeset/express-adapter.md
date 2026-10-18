---
"@hoplens/express": minor
"hoplens": minor
---

New `@hoplens/express` adapter for Express 4 and 5, also exposed as `hoplens/express` and
`hoplens/express/register`. An early preview: it captures requests, request bodies (redacted),
static assets, route templates, handler hops and the route list; middleware hops come next.

- `node -r hoplens/express/register` or `node --import hoplens/express/register` starts the runtime
  right before the app's first `listen()`. `hoplens(app)` does the same from code; called after the
  app already listens, it starts about 3 seconds later. Either way the process boots once, and a
  script that never listens binds no port.
- On when `NODE_ENV` is unset or `development`; off for `production` and `test` unless
  `HOPLENS_FORCE=1`, and off for `HOPLENS=0`. With the gate off nothing is patched and
  `@hoplens/core` is never loaded.
- The UI is served at `/__hoplens` on the app's port; the banner prints the port the server really
  bound. `persist` is on by default and writes to `node_modules/.cache/hoplens`.
- `HOPLENS_OPTIONS` (JSON) and `HOPLENS_IGNORE` (comma-separated path prefixes) configure it from the
  environment.
- When the app listens on the UI's port (or one in its retry range), the UI starts above it instead
  of taking it first. An invalid `HOPLENS_PORT` falls back to 4983.
- Requests are grouped under the route's full template, mount prefixes included
  (`/api/users/:uid/orders/:id` for a router mounted at `/api/users/:uid`), across sub-apps, routers
  mounted twice, `app.route()` chains, array and regex paths. Express 5's `/*splat` and `{/:opt}`
  show as `/:splat+` and `/:opt?`.
- Each dispatched route gets a handler hop named `<METHOD> <template>` at the line that registered
  it; hops opened in the handler nest under it. `next('route')`, `next('router')`, `next(err)`, sync
  throws and Express 5 promise rejections behave as without Hoplens.
- ESM type entries: `import hoplens from "@hoplens/express"` (and from `hoplens/express`) is typed as
  the function it is at runtime.
- The route list (`/__hoplens/api/routes`, the request builder's route picker) is read from the
  app's router: one entry per full template, with each method (`app.all()` as `ANY`) at the line
  that registered it, sub-app and parameterised-mount routes included. Routes registered later show
  on the next scan; a route under a mount Hoplens could not see is listed once a request reached it.
  Its template is the one the route's requests are grouped under.
- The request builder pre-fills a route's body from its Zod schema. Schemas are read statically
  from the route's registration call: `Schema.parse(req.body)` (also `safeParse`, `parseAsync`, and
  `req.query` / `req.params`) in an inline handler or in one referenced by name (same file, ESM or
  CommonJS import, `ns.member` / `obj.member`, or wrapped like `asyncHandler(fn)`), then validation
  middleware in the arguments: a call with a single Zod schema (`validate(Schema)`,
  `validateBody(Schema)`), with a part name and a schema (`zValidator("json", Schema)`), or with
  `{ body, query, params }` schemas. Cached per file mtime; nothing is executed.
- Handlers that only forward the request (`(req, res) => ctrl.create(req, res)`, `await`ed,
  returned, or with `.catch(next)`) are followed into the function they call, two levels deep, with
  class instances resolved as for a handler named directly.
- Routes registered in a loop over a literal route table (`for (const r of routes)
  router[r.method](r.path, ...r.middleware, r.handler)`, `routes.forEach(...)`,
  `Object.entries(map)`), in the same file or imported, get the schemas of their own table element,
  picked by path and method; when the element can't be told apart, no schema.
- A schema used as a member (`ns.OrderBody`, `S.OrderBody` of a `require`, `schemas.OrderBody` of an
  object literal) is located at its declaration, like a plain name.
- Edits across restarts: under `node --watch`, `tsx watch` or nodemon, a restart whose source files
  changed is an edit in Changes, naming the files and the routes that import them, with before /
  after verdicts once both sides have traffic. Formatting-only saves and restarts with no change add
  no edit. Needs `persist` (the default); with `persist: false` every start is one epoch and the
  banner says so. The standalone UI waits up to a second for its port after a restart instead of
  moving to the next one.
- Function hops: the register hook wraps the exported functions of the app's own modules, ES modules
  and CommonJS (under `src/`, or the usual dirs without it) as they load, so each call made during a request is a hop at
  its file and line, nested under the handler hop. Plain `.js` / `.mjs`, `.ts` that Node strips
  itself, `-r` or `--import`, and tsx in either order: `node --import hoplens/express/register
  --import tsx`, `node --import tsx --import hoplens/express/register`, and the `tsx [watch]
  --import hoplens/express/register` command `hoplens init` writes (tsx's compiled output is mapped
  back to the `.ts` file on disk). CommonJS apps work under `-r` and `--import` (the entry under
  `--import` aside: Node reads it through its ESM loader, the banner and `hoplens doctor` say so and
  suggest `-r`; a `.cts` entry Node strips itself is wrapped), including TypeScript compiled to
  CommonJS by tsx in any flag order, ts-node/register (type-checking included) in either `-r` order, and tsc output in
  `dist/` once `autoTrace.include` names it. CommonJS exports are wrapped on the exports property
  (`exports.f`, `module.exports = { f }`, tsc's `exports.f = f`); getter and frozen exports and
  `module.exports = f` load as they are. Lines and columns never move, so stack traces are unchanged. Calls
  shaped like middleware or handlers (`(req, res[, next])`, `(err, req, res, next)`) are not wrapped.
  The banner counts the wrapped functions; a TypeScript file whose compiled output does not map back
  with certainty, any other file another loader changed first, and a CommonJS file Node read through
  its ESM loader load untouched, said in one banner line (with the first such file and what did not match). Off with `HOPLENS_AUTOTRACE=0` or
  `HOPLENS_OPTIONS='{"autoTrace":false}'` (no TypeScript is loaded then); `autoTrace` passed to
  `hoplens(app, opts)` only stops the hops from binding and prints a hint. Findings owned by a
  wrapped function (an N+1 in a service) are located and fingerprinted under that function.
