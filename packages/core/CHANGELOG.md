# @hoplens/core

## 0.4.0

### Minor Changes

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

- 8a0a9cf: `HttpTap` takes an opt-in `bindRequestEmitter` flag. When an adapter sets it, every event the incoming
  request emits (`data`, `end`, ...) runs inside that request's trace, so a handler that continues from
  `end`, as Express does behind `express.json()`, keeps its hops and route, and spans started there
  nest under the last hop the adapter entered with `beginHop().run()` instead of losing their parent. Before, Node dropped the
  context after the first body chunk and a POST with a body that arrived over several ticks recorded
  nothing past the parser. Off by default: Next.js capture is unchanged.
- 0b46ca3: Request path through bundles (`RuntimeConfig.path.scripts`, `bundledScripts()`): a capture keeps only
  the coverage scripts that hold project code (Turbopack chunks, Turbopack HMR updates, webpack
  eval-source-map modules; React's `about://React/*` fakes, empty-URL `new Function` code and framework
  scripts are dropped by URL, decided once per script id) and maps each project file through its
  bundle's source map with P5's containment rules: a Turbopack chunk's sidecar sectioned map (only the
  file's own section), a webpack module's inline map, absolute Windows source paths and
  `turbopack:///[project]/` sources included. The text V8 ran comes from disk only while it provably is
  V8's (the script was seen after the file's last write, and V8's script length is the text's);
  otherwise from V8 with `HOPLENS_PATH_DEBUGGER=1` (a rewritten Turbopack chunk is re-anchored module
  by module), else the function is UNKNOWN with the new reason `stale-chunk` (only when the bundler rewrote the file
  after V8 loaded it; a text with no source map, a chunk over 4 MB or a map that cannot be read is
  `unmapped` with the chunk named in the warnings, and a failed map read is retried on the next capture).
  A map whose sourcesContent is the file vouches for a file edited after the process started. A file
  whose code ran in two bundled copies (two webpack layers) is UNKNOWN with the new reason
  `bundle-copies`. A file under the server output is kept only when it holds a project module, so Next's
  framework chunks and `webpack-runtime.js` are not counted in `window.scripts`. The payload's `window.bundled` reports the take's
  script kinds, kept files and what resolving cost (take times were already in `window.takeMs`).

  Untraced framework requests (Next's `/_next/*`, `/__nextjs*`) are reported in `window.internal`: they
  are not foreign traffic by themselves, but they rule out the "local binding" PARTIAL verdict and are
  named when a function ran more often than its hops. `TraceStore.noteInternal` / `onInternal` carry
  them. New exports: `startCoverage`, `persistDir`, the sticky-switch helpers of `path/flag.ts`
  (`flagPathControl`, `readPathFlagFile`, `writePathFlagFile`, `removePathFlagFile`), and
  `CoverageSource.take(keep)` now passes the script as `keep`'s second argument. Core loads builtins
  through `process.getBuiltinModule` when it has one, so a bundler that inlines core (Turbopack, for a
  workspace-linked core) does not break coverage. The toggle API's 409 `unsupported` no longer says
  "Express only".

- f93f120: Request path, first milestone (P1): which code a request ran, from V8 block coverage. Opt-in with
  `HOPLENS_PATH=1` (read at boot only; restart to change it). With the flag unset nothing of it loads
  and nothing runs.

  - `@hoplens/core/coverage` (new entry): starts V8 precise block coverage (`callCount`, `detailed`) on
    a main-thread inspector session and never stops it. Under `NODE_V8_COVERAGE` (c8) it refuses and
    reports `disabled-c8`, so c8's counts are never reset.
  - The Express register hook starts it first, before the function-hop shim and hooks, so every app
    module compiles with block counters. Only that one small file loads early. The banner prints
    `request path: on (block coverage; CPU-heavy code runs slower)`.
  - `POST /api/traces/:id/path` replays a GET or HEAD trace once, alone, as a new trace: it waits for
    the app to be idle (no request in flight for 150ms, max 3s, else 409 `not-quiet` and nothing is
    sent), resets the counters, runs the replay, settles 250ms (extended on late spans, max 2s) and
    takes the counts of the project's own scripts. Function-hop counts are cross-checked against
    coverage call counts, and each block against its function's call count (a block counted more
    often outside a loop is an earlier call resuming after an await). Another request in the window
    (starting, or still recording spans), more calls than hops, or such a block makes it retry once,
    then mark the capture CONTAMINATED (kept, every truth unknown, with the reasons). The same excess
    on both tries runs a control window with no replay: counts there mean background work
    (CONTAMINATED), none mean calls through a local binding (PARTIAL, unchecked). A trace past the
    1000 function-hop cap is PARTIAL without the cross-check; lanes are capped at 300. The discarded
    attempt's trace is stamped `pathTrace.supersededBy`, and listed in `window.attempts`. One capture
    at a time (409 `busy`); other methods get 400; the replay has a 30s deadline (502). Every error
    body is `{ code, error, ...details }` with a stable `code` (`method`, `not-found`, `no-path`,
    `superseded`, `evicted`, `path-off`, `busy`, `not-quiet`, `take-failed`, `replay-failed`). The payload (`v: 1`) has one lane per handler/function
    hop with file:line, call counts, function-level truth and the raw block ranges (offsets, counts,
    lines), and a quality of `exact`, `partial` or `contaminated`. `GET /api/traces/:id/path` returns
    the last 20 (410 `evicted` for an older path trace). Trace summaries and the live stream carry
    `pathTrace` (an `update` event follows the stamp). `/api/meta` reports
    `path: { state: off | on | disabled-c8 | error }`; `error` also covers precise coverage stopped by
    another inspector session (detected on take; restart the app). The trace store counts in-flight
    requests (`inflight()`).
  - `hoplens doctor` notes when `HOPLENS_PATH=1` is set in the dev script or the environment, and warns
    when `NODE_V8_COVERAGE` is set with it.

  Request path, second milestone (P2): which arm of every decision the request took.

  - The path payload is `v: 2`. Each function carries `analysis`: its decisions (`if` / `else if` /
    `else`, `switch` cases, `?:`, `&&` / `||` / `??` where the right side has a side effect or is
    the value returned, `try` / `catch`), each arm `taken`, `not-taken` or `unknown` with a reason;
    its loops (entries, passes); its exits (return, throw, falling off the end, an exception from a
    callee) with the decision arm each sits in; and the annotated node tree for the flowchart. The
    payload's `analysis.text` is the request's verdict line (`Exited: return at GET
/api/products/:id L21 via if !(await findProduct(id)) -> then`). Built once, lazily, on the
    POST that captured it or the first GET, and cached with the payload (a few ms per route on the
    example app once TypeScript is loaded).
  - Counts are structural, not V8's innermost range: code after an always-exiting arm (an early
    return) is never shown as reached, however V8 clipped its ranges. Arms that sum past their
    decision are `arms-inconsistent`. A split inside one call reads `split-loop` (`then 1/3 . else
2/3`), across calls `split-calls`; a function called more than once is `blended`, counts are
    totals.
  - The throw cut: code after an exception the counters cannot place (a callee that threw
    synchronously, an exception a `finally` replaced) is `after-throw`; the hops' error stacks
    (recorded per function at capture as `errors`) narrow it to the statement that threw when they
    account for every exception there. Awaited rejections stay exact.
  - Join validation: the file must hash as it did at capture and not have been modified after the
    app started (`stale`), else `source-moved`; and the function's AST start and end must be its
    coverage range, else `compiled` for a TypeScript file, `no-function` otherwise (`too-large` when
    a cap left the file without functions).
  - Exits are completions: a `return` / `throw` that left the function (a throw its own catch took is
    none), unknown when an exception may have been raised inside it or in a `finally` it passed.
    When the counted exits add up to the calls, the unknown ones are 0 (an uncaught callee throw
    reads `Threw: exception in <handler> L<n>`, the line of the escaping error; `(line unknown)` when
    no recorded stack settles it). A deficit the hops did not record as an error (an await still
    pending, a generator parked at a yield) is `suspended`, not an exception.
  - Code a statement may skip (optional-chain arguments, destructuring defaults) is never read as an
    exception; a logical there has its short-circuit arm `no-counter`. A function whose parameters
    can run code, or a generator, does not count its first statement from the call count.
  - The flowchart graph carries each switch clause's matched count (`sharedArm` for grouped empty
    clauses) and a structural `fallsThrough` (never on the last clause); loop passes read as in
    `loops`; `fns` (functions created at a node, with `fnKey` when the payload has one) and
    `callees` (a call linked to a function the trace recorded as a hop under this one, when the name
    picks exactly one).
  - `RuntimeConfig.path.analyzer` supplies the control-flow model; `@hoplens/express` passes
    `@hoplens/transform/cfg` and loads TypeScript once after boot when `HOPLENS_PATH=1`. Without an
    analyzer every decision is `no-analyzer`.

  Request path, fifth milestone (P5): TypeScript and other compiled setups, exact where the mapping is
  certain.

  - V8's offsets point into the text it ran. For plain JavaScript and Node's own type stripping (Node
    22.18+ by default, or `--experimental-strip-types`: types become spaces) that is the file on disk
    (identity, as before). For a loader's output (tsx: ESM or CommonJS, `tsx watch`) the function's
    analysis now runs on that generated text's own control-flow model (identity on the text V8 ran),
    and is carried over to the file only when its inline source map pairs the two models node for
    node: the same tree (kinds, arms, cases, exits, loops, expression decisions, awaits, nested
    functions) with every executable node's map anchors inside the paired raw node (none of another
    source). The result shows the file's own lines and labels; the function has `mapping:
sourcemap` and `generated: { hash, length, via }`. A compiler that drops, adds or reorders code
    in a function (a dead statement it removed) leaves it UNKNOWN `unmapped` with the reason in the
    payload's warnings; nothing is guessed.
  - The generated text comes from Hoplens' own loaders while the request path is on: the ESM hook in
    COMPILED mode (`tsx --import hoplens/express/register`) posts what V8 will run, and the CommonJS
    layer keeps what a require hook (tsx's) hands `module._compile`; only output with an inline source
    map, bounded (1M chars per file, 16M in all, least recent dropped). Checked against V8 (the module
    function's length) and the map's `sourcesContent` when present (a prefix is fine: Hoplens' trailer).
  - When a source map says the script is compiled but no text was kept (tsx registered after Hoplens,
    so it ran first), every function is UNKNOWN `no-generated-text` with how to fix the order.
    `HOPLENS_PATH_DEBUGGER=1` opts in to reading those scripts with `Debugger.getScriptSource` after
    the capture's final take (about 200ms the first time on the test app; `window.debuggerMs`), through
    one Debugger session kept enabled for the life of the process (disabling it would drop V8's block
    counts). The warning says why no text is at hand: Hoplens' loaders off, a size cap, Node's own
    `--experimental-transform-types`, or the loader order. Retained texts are least recently used out,
    reads included; decoded maps and generated models are cached across captures.
  - New reasons: `unmapped`, `no-generated-text`. `register({ retainGenerated })` in
    `@hoplens/transform`; `@hoplens/express` sets it when the request path is on.

- 94bdfa5: Request path: a sticky one-click switch. The path stays off by default; turning it on no longer needs
  `HOPLENS_PATH=1` in every shell.

  - `@hoplens/express`: the register hook reads `<stateDir>/path.json`
    (`{"enabled":true,"since":ISO,"by":"ui"|"init"}`; `node_modules/.cache/hoplens` by default,
    honouring `HOPLENS_OPTIONS` `stateDir` / `root`) before coverage would start. `HOPLENS_PATH=1` / `0`
    always wins, then the flag, else off; the dev gate is unchanged. With the path off the hook only
    reads that one small file. The banner says `request path: on (flag; disable in the Path view, press x on a request)` or
    `request path: on (HOPLENS_PATH)`.
  - `@hoplens/core`: `RuntimeConfig.path.control` (`PathControl`) is an adapter's switch.
    `POST /api/path/enable` and `/api/path/disable` write / remove the flag atomically and answer the
    new `meta.path`. Loopback callers only (even with `allowRemote`), and a non-local `Origin` gets
    403; 409 `env` when `HOPLENS_PATH` decided, 409 `unsupported` without a control (Next.js: Express
    only), 500 `write-failed`. `meta.path` gains `source` (`env` | `flag` | `default`) and `pending`
    (`on` | `off`) until the restart applies a toggle.
  - `@hoplens/ui`: the Path view's off state has an **Enable request path** button (block coverage from
    start; CPU-heavy code runs slower), then "Restart your dev server to apply (saving a file restarts
    node --watch)" with an `on at next start` badge and Undo. On via the flag, the pane's footer has a
    Disable link (`off at next start` and Keep it on after). Set by `HOPLENS_PATH`, it says so and
    offers no toggle. The copyable env command stays as the secondary option.
  - `@hoplens/cli`: `hoplens init` (Express) asks "Enable request path tracing? (block coverage;
    slower for CPU-heavy code) [y/N]" in a terminal (default no; never asked without a TTY),
    `--path` / `--no-path` answer it, and `--dry-run` prints the flag instead of writing it. `remove`
    deletes the flag (with the state dir). `doctor` reports `request path: on (flag)`,
    `on (HOPLENS_PATH)` or `off`, and warns when it would be on with `NODE_V8_COVERAGE` set or when
    the flag file is invalid.

### Patch Changes

- 46a3673: Security: one guard now fronts every `/__hoplens` route (the UI page, the API, the SSE streams), not just the request path switch. The `Host` and any `x-forwarded-host` must name this machine (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`, any port), which stops DNS rebinding; a browser's `Origin` must be local too (any port, so the Vite dev proxy and the app-port mount keep working). Refusals are 403 `{ code: "forbidden" }` and say where to open Hoplens. `POST` and `DELETE` from a browser must send `content-type: application/json`, and text/plain, form and multipart bodies are refused (415 `{ code: "content-type" }`): a cross-site page can no longer replay requests through `POST /api/run` with a simple request. Scripts that post JSON without the header need to add it. `allowRemote: true` keeps serving any client and Host (rebinding protection is off there; the Origin and content-type checks stay), and the request path switch still answers this machine only. The UI sends the JSON content type on its writes.
- c3e3d79: A `duplicate` finding whose repeats each run inside their own call of the same traced function
  (`findProduct(id)` called twice) is now owned by the caller and located at the repeat call, the line
  that called it the second time, like `n-plus-1` does for loops. Its title names the function ("ran x2
  via findProduct()"). Before, it pointed at the function's own declaration, where the code snippet
  shows one call and not the repetition. The finding's fingerprint changes for these cases.
- fe39345: Request path: `GET /api/source` also returns `hash`, the sha1/12 of the whole file as it is now (the
  same hash a path trace records per function), so the UI can tell when a file changed after its
  trace. Graph nodes carry `ambiguous`: the calls left unlinked because more than one recorded hop of
  the function matches the name.
- b748270: `Runtime.routeInfo()` picks, among discovery entries that share a template, the one that declares
  the request's method, and ignores entries with no source file instead of giving the trace an empty
  route file and handler location.
- 1f1e364: A file saved right after the source watcher started is no longer lost: the startup pre-hash read the
  new bytes and kept them as the baseline, so the save's own change event looked like a same-bytes
  save and was dropped (29 of 30 rapid saves after start went missing). Files modified within 100ms of
  the watcher starting, or later, are left out of the baseline.
- c3e3d79: A response body over the 512KB capture limit keeps its first 512KB even when it is written in one
  chunk (`res.json()` of a large export, `NextResponse.json` of a big list). Before, a single chunk past
  the limit was dropped whole, so the Response tab said "truncated" over an empty body. The label now
  says how much is shown ("truncated: first 20KB of 2.0MB shown").
- c3e3d79: The standalone UI no longer gives up when its port sits in a Windows excluded port range (Hyper-V and
  WSL reserve blocks of ports, and binding one fails with `EACCES`): it moves on to the next port, as
  it does for a port in use.
- 15df8f3: Traced functions behave like the originals inside a request. Argument and result previews never run
  app code or throw: a Proxy shows as `[Proxy]`, an accessor as `[Getter]`, anything unreadable as
  `[unreadable]`. A promise the function decorated (`p.cancel = ...`, a subclass) comes back as the same
  object. A trace records at most 1000 function spans; later calls run unwrapped and count in
  `droppedSpans`.
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

- b748270: The request builder opens the route entry that declares the request's method when several entries
  share one template (an Express route registered in two files, or GET and POST on separate lines),
  falling back to one that accepts any method. A `route:/` filter now matches only `/` instead of every
  route.
- Updated dependencies [46a3673]
- Updated dependencies [c3e3d79]
- Updated dependencies [94bdfa5]
- Updated dependencies [b748270]
- Updated dependencies [fe8560e]
- Updated dependencies [0b46ca3]
- Updated dependencies [8eb6d4c]
  - @hoplens/ui@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [35d2b68]
- Updated dependencies [11e1b1f]
  - @hoplens/ui@0.3.1

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
  - @hoplens/ui@0.3.0

## 0.2.0

### Minor Changes

- 5bf7200: Every finished request now explains itself, and the runtime keeps what it
  learns across requests, edits and (optionally) restarts. All of it runs after
  the response, off the request path; the per-request pipeline is gated at
  under 2 ms by `pnpm --filter @hoplens/core bench`.

  **Facts** (`trace.facts`): where the time went, as interval-union self time so
  the buckets add up to the request (`db`, `cache`, `ext`, `fn` = your code,
  `framework`, `compile`, `idle`), plus TTFB, request and response bytes, span
  counts, a `cold` flag and the dev-rebuild `epoch`.

  **Findings** (`trace.findings`): nine rules with stable fingerprints, so the
  same problem groups across requests: N+1 (including a loop over a traced
  per-item function), duplicate calls, parallelizable chains of 3+, slow
  functions, fetches that opt out of Next's data cache, cold compiles, large
  payloads, swallowed errors and warn/error logs on a success. Tune them with
  the new `insights` option (`thresholds`, `disable`).

  **Read APIs** under `/__hoplens/api`:

  - `GET /stats[?buckets=1&since=]`: per-route latency histograms that outlive
    the trace ring (exact quantiles while a sample is small, per URL variant),
    a findings rollup ranked by saveable ms per request × requests, error kinds,
    per-edit p50 deltas, example requests (failed ones excluded) and the count
    of requests in epochs no longer kept.
  - `GET /traces?q=&since=`: a small query language (`status:5xx dur:>200
route:/api/* method:post has:n+1 kind:route cold:true "free text"`, `-`
    negates; free text also searches logs and bodies). The grammar ships as
    the pure `@hoplens/core/query` subpath.
  - `GET /queries[?kind=db|cache|fetch]`: normalized query and host shapes
    with calls, p95, errors, routes and callers.
  - `DELETE /traces` clears the buffer and broadcasts an SSE `clear`.
  - `GET /health` and `/health/stream`: event-loop delay (without the sampler's
    own timer interval), memory, GC, and uncaught exceptions / unhandled
    rejections. `/events` also carries `health` ticks.
  - `GET /compare?a=&b=`, `/compare/baselines`, `/compare/pins`: span-level and
    shape-level diff of two traces (`x10 -> x1`), bucket deltas and a JSON diff
    of the bodies. Compared traces are pinned past ring rotation; a manual pin
    (`POST /compare/pins/:id`) is never released by automatic ones.
  - `GET /epochs`, `/regressions`, `/epochs/events`: dev rebuilds as edits,
    attributed to the saved files (a source watcher), the routes that import
    them, and a module-level diff of the rebuilt chunks. A save that changes no
    module code is not an edit, and a route the rebuild didn't touch is not
    marked cold. A regression compares the URL variants present on both sides
    of an edit, so a change in traffic mix is not reported as a slowdown, and a
    verdict outlives the baseline it was judged against.
  - `POST /run?repeat=N` replays a request up to 50 times in sequence. It stops
    at the first 5xx unless `keepGoing` is set, has a 120 s total limit, and
    reports warm p50/p95 against the previous batch. A body that is not JSON
    gets a 400; only a batch that never reached the app returns 502.

  **Persistence** (`persist: true`, off by default): facts and summaries are
  appended as NDJSON to `<distDir>/cache/hoplens` (two files of at most 5 MB),
  so stats, edits and verdicts survive a dev restart. Bodies, headers, spans,
  logs and error messages are never written; titles that quote a log line or
  an error are stored without the text, and URL query values are masked unless
  short and plain.

  `Runtime.stop()` stops every background task (health sampler, watchers,
  persistence after a final flush) and the standalone UI server. It is
  idempotent and also runs on process exit.

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

### Patch Changes

- Updated dependencies [5bf7200]
  - @hoplens/ui@0.2.0
