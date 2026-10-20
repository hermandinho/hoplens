# @hoplens/next

## 0.4.0

### Minor Changes

- 0b46ca3: Request path for Next dev (Turbopack and `--webpack`). With `HOPLENS_PATH=1`, or the sticky switch
  (the Path view's Enable button, `hoplens init --path`: `.next/cache/hoplens/path.json`, or
  withHoplens' `stateDir`), the instrumentation hook starts V8 block coverage first thing, before the
  first request's proxy and route code, and Trace path replays a GET once and shows which branches of
  your route and lib functions ran. Nothing of the inspector loads while it is off; NODE_V8_COVERAGE
  (c8) keeps it disabled; HOPLENS_PATH always wins over the switch, which applies at the next start
  of `next dev`. Coverage runs from that start, so CPU-heavy code runs slower. The banner says when it
  is on.

### Patch Changes

- 8a0a9cf: Opt-in seams for framework adapters other than Next.js, so one can plug into the runtime without
  importing core's AsyncLocalStorage or `@opentelemetry/api`:

  - `HttpTap.describe(req, res)` names a finished request's route template and kind when no span
    carried `next.route`. The route is used as given (only Next's `/route` suffix is stripped) and
    still resolves its route file and handler line through discovery.
  - `HttpTap.requestBody(req)` hands over a body the framework already parsed, for traces the Fetch
    `Request` hooks saw no body on. It is redacted and previewed like any captured JSON body.
  - `Runtime.currentTrace()` and `Runtime.beginHop(kind, { name, file, line })` let an adapter
    annotate the current request and open its own hops; `end(err)` records a failure the way a
    throwing traced function does. `exit(fn)` runs work the hop hands off to (an Express `next()`) in
    the context the hop began in, so it lands as the hop's sibling.
  - `RuntimeConfig.epochs: { mode: "none" }` never bumps the epoch on a rebuild, so each process is
    one epoch (with `persist`, a restart starts the next one), for frameworks with no build output:
    no build-output or source watchers, no chunk index. `"build"` stays the default.
  - `options.stateDir` moves the `persist` files out of `<distDir>/cache/hoplens`.
  - `RuntimeConfig.framework` is reported as `framework` by `/api/meta`. `@hoplens/next` now passes
    `{ name: "next", version }`; its other meta fields are unchanged.
  - `Runtime.start()` no longer throws when the UI port is rejected synchronously (an out-of-range
    port): it logs and runs the banner as for a busy port. Once a runtime is stopped
    (`Runtime.isStopped`), its http hook passes every request through untouched.
  - `@hoplens/next` marks its `next` peer optional, so installing `hoplens` for an Express app no
    longer pulls in Next.js and React.
  - `RuntimeConfig.epochs: { mode: "restart" }` for apps a watcher restarts on every save (node
    --watch, tsx watch, nodemon). Like `"none"` it runs no build-output probe, chunk index or source
    watcher; with `persist` each start hashes the project's source files and compares them with the
    manifest the previous process wrote (`sources.manifest` in the persist dir, replaced atomically). A
    restart that changed code opens an epoch with the new `via: "restart"`, naming the changed, added
    and deleted files; `/api/epochs` maps them to routes through the import graph and regressions
    compare the routes before and after it from the persisted stats. Whitespace, comments, quote style,
    semicolons and trailing commas don't count (JS / TS / JSON are compared by TypeScript scanner
    tokens; `epochs.typescript` supplies the TypeScript), so a formatter-only save or a restart with no
    change continues the current epoch. Rows are flushed every 250ms in this mode. `"build"` stays the
    default and `"none"` is unchanged.
  - `RuntimeConfig.samePortRetryMs`: when the UI port is busy at start, retry that same port for up to
    this long before moving to the next one (default 0, unchanged).
  - The source watcher's fallback dirs (no `src/`) gain `routes`, `controllers`, `middleware` and
    `models`.
  - `/api/epochs` lists every route registered in an affected file (it kept one per file, which only
    fit Next's one-route files). For a restart edit the walk from one registration file does not go on
    through another, so a router edit does not mark the routes `app.js` registers itself.

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

- fe8560e: `@hoplens/schema` exports `SchemaProject`, the schema finder and cross-file resolver the Next
  adapter used internally (imports, re-exports, barrels, aliases, namespace imports, a per-mtime
  source-file cache), plus `fieldsOf`, `scriptKind`, `objectMember`, `PARSE_METHODS` and the
  `SchemaInfo` type. Opt-in options follow CommonJS `require` / `module.exports`, resolve a default
  import to `export default function`, and add a body-input pattern; the Express adapter uses them.
  `@hoplens/next` now calls it, with no change in what it finds. A schema name shadowed by a function
  parameter or local binding is no longer resolved to the top-level declaration, and CommonJS
  re-export barrels (`module.exports = require("./x")`) are followed. A new opt-in
  `memberDeclarations` option (used by Express, off for Next) locates a member-access schema
  (`ns.Body`, a required module's `S.Body`, an object literal's `schemas.Body` or `a.b.Body`) at its
  declaration instead of the call site, and reads object-literal members for their shape;
  `localBinding` is exported for adapters.
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
- Updated dependencies [94bdfa5]
- Updated dependencies [c520fcb]
- Updated dependencies [fe8560e]
- Updated dependencies [dda80a9]
- Updated dependencies [d11e0a8]
- Updated dependencies [15df8f3]
- Updated dependencies [c520fcb]
- Updated dependencies [b748270]
  - @hoplens/core@0.4.0
  - @hoplens/transform@0.4.0
  - @hoplens/schema@0.4.0

## 0.3.1

### Patch Changes

- @hoplens/core@0.3.1

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

## 0.2.0

### Patch Changes

- Updated dependencies [5bf7200]
- Updated dependencies [5bf7200]
  - @hoplens/core@0.2.0
