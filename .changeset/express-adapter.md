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
