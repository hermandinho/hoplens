# hoplens

## 0.4.0

### Minor Changes

- e46e5b3: `hoplens init`, `doctor` and `remove` support Express projects. The framework is detected from
  package.json (`next` or `express`); a project with both needs `--framework next|express`, which all
  three commands now take.

  - `init` adds `--import hoplens/express/register` to `scripts.dev` (else `start:dev`, else `watch`)
    and changes no other byte of package.json (indentation, key order, CRLF, trailing newline). It
    wires `node [--watch]`, `tsx [watch]` and `nodemon` (as `--exec "node --import ..."`, or inside an
    existing `--exec "node ..."`), keeping env prefixes such as `cross-env NODE_ENV=development` and
    `&&` chains: only the command that starts the app gets the flag. Other runners (`ts-node-dev`,
    `ts-node`, `pm2`, `bun`, `docker`) are left alone with the line to use printed, and with no dev
    script it prints the one to add. `scripts.start` and the entry file are never edited. A second
    run reports "already wired". `--dry-run` shows a `-`/`+` preview; the install hint and next steps
    use the project's package manager and, when it can tell, the app's port.
  - `doctor` checks that `hoplens` is resolvable from the project (not through `NODE_PATH`; with pnpm
    the `hoplens/express/register` form is recommended), that Express is 4 or 5, and that the dev
    script loads the hook. The hook in `scripts.start` or a production-looking script is critical;
    `NODE_OPTIONS` carrying it (scripts or `.env*`) and `NODE_ENV=production` in the dev script warn;
    a `hoplens(app)` call in the entry file is noted. Same output and exit codes as the Next checks.
  - `remove` takes out exactly what `init` added, so the dev script is byte-identical to before, and
    deletes `node_modules/.cache/hoplens`. The dependency stays, as for Next.

- 86a4b76: `hoplens init` on Next.js no longer imports `hoplens/next` at the top of `next.config`, so `next build`
  and `next start` work on an install without dev dependencies (they failed with "Cannot find module
  'hoplens/next'"). init exports a function that returns your config unchanged outside
  `PHASE_DEVELOPMENT_SERVER` and loads `withHoplens` lazily in `next dev`, for `.ts`, `.mts`, `.mjs`,
  `.js` (CommonJS or ESM) and `.cjs`; `.ts` files use `"hoplens/next" as string` (and
  `"hoplens/node" as string` in `instrumentation.ts`) so next build's type check passes once hoplens is
  pruned. Re-running init upgrades a config written by an older init (keeping its specifier and
  options) and is a no-op after that; `remove` gives back the original config byte for byte from
  either form; `doctor` warns on the old form ("next build/start without dev dependencies will fail;
  run npx hoplens init to upgrade") and on a plain-literal `hoplens/node` import in `instrumentation.ts`.
  Behind the gate, `withHoplens(config, { enabled: true })` no longer turns Hoplens on outside `next dev`.
- 0b46ca3: `hoplens init` asks about request path tracing for Next projects too (in a terminal, default no;
  `--path` / `--no-path` without asking) and writes the flag where `@hoplens/next` reads it:
  `.next/cache/hoplens/path.json` (next.config's `distDir`, or withHoplens' `stateDir`, when they are
  plain strings). `hoplens doctor` reports the request path for Next as it does for Express (HOPLENS_PATH
  in `scripts.dev` or the environment wins over the flag; c8 keeps it disabled), and `hoplens remove`
  deletes the flag with `.next/cache/hoplens`.
- 0fd9994: New `@hoplens/express` adapter for Express 4 and 5, also exposed as `hoplens/express` and
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

- 0b46ca3: Request path for Next dev (Turbopack and `--webpack`). With `HOPLENS_PATH=1`, or the sticky switch
  (the Path view's Enable button, `hoplens init --path`: `.next/cache/hoplens/path.json`, or
  withHoplens' `stateDir`), the instrumentation hook starts V8 block coverage first thing, before the
  first request's proxy and route code, and Trace path replays a GET once and shows which branches of
  your route and lib functions ran. Nothing of the inspector loads while it is off; NODE_V8_COVERAGE
  (c8) keeps it disabled; HOPLENS_PATH always wins over the switch, which applies at the next start
  of `next dev`. Coverage runs from that start, so CPU-heavy code runs slower. The banner says when it
  is on.

### Patch Changes

- c520fcb: Fixes found while checking a real install and the docs:

  - Next with pnpm: the Turbopack and webpack rules now get `@hoplens/transform/loader` as an absolute
    path resolved from `@hoplens/next` itself, and the UI is found through `@hoplens/core`. Before, pnpm
    (which does not hoist transitive dependencies) failed with "Could not parse module
    instrumentation.ts, file not found" (Turbopack) or "Cannot find module '@hoplens/transform/loader'"
    (webpack). If the loader can't be found, function hops are skipped and `next dev` keeps running.
  - Next: an edit to the first route a fresh `next dev` served now opens an epoch. The tracker records a
    baseline of the chunks compiled before its first probe; before, Turbopack's in-place rewrite of that
    chunk looked like added modules only and the edit was dropped.
  - Per-request analysis is about a third faster (facts sweep without per-span event objects, bounded
    shape caches instead of a per-span WeakMap); results are unchanged.
  - Restart edits: a `.json` file no module imports never counts as a code edit, wherever it sits;
    `package.json`, `tsconfig*.json` and `jsconfig*.json` still do.
  - doctor: the `.ts` entry check reports an error only for a plain `node` run with no TypeScript loader,
    judged by the Node version the project pins; unknown runners get an info line. The port line says
    the UI uses 4983, or the first free port up to 4993.
  - The request path UI is called "the Path view (press x on a request)" everywhere.
  - The `hoplens` package description mentions Express.
  - Windows: function hops work for a project whose path contains an 8.3 short name (e.g. a temp dir
    under `C:\Users\RUNNER~1`). The hooks resolved the scope root with `fs.realpathSync.native`, which
    expands the short name, while Node's own resolvers keep it, so no file matched and nothing was
    wrapped.

- Updated dependencies [dda80a9]
- Updated dependencies [e46e5b3]
- Updated dependencies [86a4b76]
- Updated dependencies [0b46ca3]
- Updated dependencies [8a0a9cf]
- Updated dependencies [46a3673]
- Updated dependencies [8a0a9cf]
- Updated dependencies [c3e3d79]
- Updated dependencies [fe39345]
- Updated dependencies [0b46ca3]
- Updated dependencies [f93f120]
- Updated dependencies [b748270]
- Updated dependencies [1f1e364]
- Updated dependencies [c3e3d79]
- Updated dependencies [c3e3d79]
- Updated dependencies [15df8f3]
- Updated dependencies [0fd9994]
- Updated dependencies [94bdfa5]
- Updated dependencies [dda80a9]
- Updated dependencies [c520fcb]
- Updated dependencies [0b46ca3]
- Updated dependencies [fe8560e]
- Updated dependencies [c520fcb]
- Updated dependencies [b748270]
  - @hoplens/cli@0.4.0
  - @hoplens/core@0.4.0
  - @hoplens/next@0.4.0
  - @hoplens/express@0.4.0

## 0.3.1

### Patch Changes

- @hoplens/core@0.3.1
- @hoplens/next@0.3.1

## 0.3.0

### Minor Changes

- aa38442: postgres.js (`postgres`) queries show up in the journey with no setup, Drizzle's
  `drizzle-orm/postgres-js` included. Each query is a `postgres.query` db span
  with its real duration, the SQL as sent, redacted bound params, the row count
  and the call site of a tagged-template query. The driver's own queries
  (array-type fetch, session state) are left out, and so are cursors and
  `COPY` streams.

  Under Next, `withHoplens` adds `postgres` to `serverExternalPackages` in dev
  when the app can resolve it, because a bundled copy can't be instrumented. It
  skips this when `postgres` is in `transpilePackages`.

### Patch Changes

- Updated dependencies [aa38442]
  - @hoplens/core@0.3.0
  - @hoplens/next@0.3.0

## 0.2.0

### Minor Changes

- 5bf7200: Deeper capture: outgoing calls, databases and caches show up in the journey
  with no extra setup.

  - `globalThis.fetch` is wrapped per request: every call is a `fetch` span
    with cache attribution, both the request side (`cache`, `next.revalidate`,
    `next.tags`) and the CDN response headers (`x-vercel-cache`,
    `cf-cache-status`, `age`). This works with or without
    Next's own OTel. Next's `AppRender.fetch` span and Hoplens's span for the
    same call are folded into one, so each call is counted once.
  - `pg` (node-postgres) is patched when your app has it: every query is a
    `db` span with the SQL, redacted bound params and the row count.
    `Pool.query` (callback form) gets real timings.
  - `ioredis` and `node-redis` v4+ are patched when installed: each command is
    a span with the command, redacted args, the key, hit/miss for reads and the
    value size. Redis time counts as `cache`, not `db`.
  - Prisma (with `@prisma/instrumentation`) and any OTel span with `db.*`
    attributes are picked up as `db` spans; their bound params go through the
    redactor. `drizzleLogger()` from `@hoplens/core/trace` reports Drizzle
    queries.
  - Spans carry a source location where one can be found, and an N+1 through
    a per-item function points at the loop's call site, not the function's
    declaration (`location.via: "call-site"`).
  - Dev compile has its own hop kind, and Turbopack's untraced on-demand
    compile gap is counted as compile time instead of idle.
  - Spans that end after the response are kept in the timeline (marked late)
    and refresh open views through a throttled SSE `update` event.
  - Dev responses carry `x-hoplens-trace: <id>` and a `Server-Timing` header
    (db, cache, ext, fn, compile, total), appended to any existing one and
    never sent in production. Turn it off with `serverTiming: false`.

- 5bf7200: A redesigned UI that leads with the cause: one list and one subject per view,
  a sentence before the chart, and the keyboard everywhere.

  **Shell.** Four views, Overview, Requests, Queries and Changes, each a list
  beside the subject you picked, with a draggable splitter that is remembered.
  The URL hash holds the state (`#/r/<id>[/s/<span>]`, `#/route/<key>`,
  `#/q/<shape>`, `#/changes/e<n>`, `#/cmp/<a>..<b>`, `?since=e<n>`), so every
  screen has a link and Back / Forward work; old `#trace=` links still open. The
  top bar shows event-loop delay, memory and request rate, keeps a single loop
  stall visible for a few seconds, and opens uncaught exceptions and unhandled
  rejections in a panel.

  **A request** opens with one verdict: what made it slow or fail, about how
  much fixing it would save, and where. N+1 loops point at the call inside the
  loop, an error caught inside a 2xx reads "Failed silently", a cold request
  names its pre-handler wait. A "Where to look" list, the time budget bar and
  baselines (same URL, the route, the same URL before the last edit) follow.
  The journey is a Tree / Flame canvas with a minimap, the critical path, idle
  gaps, log ticks, late spans and repeated calls folded into `xN` rows; a cold
  trace opens zoomed to the handler. Details have Response, Request, Console and
  Span tabs, with a JSON tree for bodies, args and results, the source inline,
  and the logs written during a failing step. The copy menu gives curl,
  `fetch()`, a Vitest test (status, query budget, p95-based time budget) or the
  trace link. Status badges follow the HTTP status; an error handled inside a
  2xx gets its own amber badge.

  **Requests** is a windowed log with aligned columns that drop as it narrows,
  a query bar with autocomplete, finding badges that prefill a query and
  duration bars scaled to p95. Live rows never move the row under your pointer
  (an "N new" pill appears instead), and a replay batch is one row.

  **Overview** leads with the top repeatable finding, ranked by saveable ms
  per request × requests; findings seen once, dev compiles and findings an edit
  fixed ("not seen since e5") rank last. Below: routes by time spent with a
  per-edit p50 delta, and one errors line (5xx / thrown / swallowed) whose
  filters match its counts. A route opens with fast / typical / slow example
  requests. Cold requests are excluded from percentiles unless "Include cold"
  is on.

  **Queries** lists every db, cache and fetch shape across requests (SQL /
  Cache / Fetch), sortable, with a loop chip and a "Group by host" toggle that
  follows the column sort.

  **Compare** merges two requests into one diff: a summary sentence, a bucket
  table, count changes, findings added and resolved, a span tree with an
  only-changes toggle, and response and request diffs. Changes under
  max(20%, 5ms) count as noise. **Replay** runs a request once or ×10 with warm
  p50/p95, a per-run strip and "vs last run", from the request or the builder.

  **Changes** is a timeline of your edits (dev rebuilds) with one dot per
  request: the files saved, the routes the edit affects and a verdict per
  route. Routes the edit doesn't touch are listed apart, muted; a revert that
  undid a regression says so; edits restored from an earlier session are
  greyed. A rebuild toast names a route that got slower and goes away if a
  later verdict clears it. The since scope (`?since=e<n>`) narrows the
  Overview, the log and Changes to an edit and later, behind a chip, and says
  when its counts are a lower bound.

  **Keys.** `Ctrl/Cmd+K` opens a palette over findings, routes, recent
  requests, query shapes, edits, views and actions. `?` lists the keys that
  work where you are, generated from the same keymap as the footer hints:
  `1`-`4` views, `/` filter, `j`/`k` move, `Enter`/`Space` open/peek, `[`/`]`
  newer/older, `f` highlight the cause, `o` open the source, `t` tree/flame,
  `z`/`0` zoom, `c` compare (`c c` picks the baseline), `d` vs the previous
  build, `p` pin, `r`/`R` replay once/×10, `y` copy, `b` builder, `s`/`e`/`E`
  since scope, `Ctrl+\` collapse the list, `Esc` back.

  **Phones** (≤ 760px): bottom tabs, subject pages with Back and swipe, a
  tree-only canvas, details in a bottom sheet, and no key hints on touch.

  Colour and type come from one token set with separate hue families for time
  buckets, severity, accent and diffs, checked for contrast in CI.

### Patch Changes

- 5bf7200: `npm i -D hoplens` is the only install step again: `npx hoplens init` no
  longer leaves TypeScript reporting `Cannot find module '@hoplens/next'` on
  pnpm projects.

  0.1.x wrote `import { withHoplens } from "@hoplens/next"` into
  `next.config.ts`. That resolves at runtime through pnpm's symlinks, but not
  for TypeScript, because pnpm never hoists transitive dependencies, so users
  needed a second `pnpm add -D @hoplens/next`. Both imports now go through the
  meta package's subpaths:

  - `init` writes `from "hoplens/next"` and `await import("hoplens/node")`
    (a new `./node` subpath). The meta bundles the `@hoplens/next` and
    `@hoplens/core` code and types into `dist/next.*` and `dist/node.*`.
  - `doctor` and `remove` accept both the new and the legacy form, so
    re-running them on an older install stays idempotent and byte-identical.
  - `remove` also deletes what Hoplens wrote under the build output:
    `<distDir>/cache/hoplens` (from `persist: true`) and
    `<distDir>/cache/hoplens.json`.

- Updated dependencies [5bf7200]
- Updated dependencies [5bf7200]
- Updated dependencies [5bf7200]
  - @hoplens/cli@0.2.0
  - @hoplens/core@0.2.0
  - @hoplens/next@0.2.0

## 0.1.1

### Patch Changes

- baf9393: Fix `npx hoplens init` failing with `ERR_PACKAGE_PATH_NOT_EXPORTED` when
  installed as a transitive dep (the real user flow — `npm i -D hoplens`).

  `@hoplens/cli` only exposed `./package.json` via its `exports` field, so
  the meta's bin shim's `require("@hoplens/cli/dist/cli.js")` was blocked by
  Node's modern resolver. Now `@hoplens/cli` has `main` + `exports["."]`
  pointing at `dist/cli.js`, and the meta shim uses the clean
  `require("@hoplens/cli")` form.

  Also tightens `e2e/scripts/verify-install.mjs` to install `hoplens` as
  the sole direct dep (with the six `@hoplens/*` workspaces redirected to
  local tarballs via npm `overrides`), so this failure mode is caught by
  CI next time.

- Updated dependencies [baf9393]
  - @hoplens/cli@0.1.1
