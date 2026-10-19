# Hoplens working notes

Operating guide for anyone (human or agent) touching this repo. Keep this file current.

## Commands

```bash
# install everything, link workspace packages
pnpm install

# build all publishable packages (packages/*)
pnpm build
# (`pnpm -r build` also runs `next build` in examples/next16-app, which rewrites its next-env.d.ts)

# strict typecheck, in parallel
pnpm -r typecheck

# vitest in every package that has tests (ui also runs the design-token guard first)
pnpm -r test

# per-request overhead gate: the whole pipeline < 2 ms, Server-Timing < 0.5 ms
pnpm --filter @hoplens/core bench

# biome: lint + format
pnpm lint
pnpm format

# run the Next.js example (end-to-end smoke)
pnpm --filter example-next16-app dev
# → http://localhost:3000/__hoplens

# run the Express example (register hook via the `hoplens` meta package; seeded problems in its README)
pnpm --filter example-express-app dev
# → http://localhost:3100/__hoplens   (then: pnpm --filter example-express-app traffic)

# release workflow
pnpm changeset           # describe your change
pnpm release             # publishes (CI does this)
```

## Architecture map

Hoplens is split so that **everything downstream of the HTTP tap is framework-neutral**. Only the thin adapters know about Next vs Nest vs Express.

```
┌────────────────────────── user's Node framework (Next, Nest, Express, …) ──────────────────────────┐
│                                                                                                    │
│   ┌─────────────────┐   patches http.Server.emit                                                   │
│   │  @hoplens/next  │ ─────────────────────────────┐                                               │
│   └─────────────────┘                              │                                               │
│   (route scan, proxy.ts, withHoplens config wrap)  ▼                                               │
│                                      ┌──────────────────────────────┐                              │
│                                      │        @hoplens/core         │                              │
│                                      │  ─────────────────────────   │                              │
│                                      │  Runtime                     │                              │
│                                      │  ├─ capture: http emit,      │                              │
│                                      │  │   body, console, OTel     │                              │
│                                      │  ├─ store: ring buffer + SSE │                              │
│                                      │  ├─ server: /__hoplens UI    │                              │
│                                      │  ├─ sourcemap: TP + webpack  │                              │
│                                      │  ├─ serialize: redactor      │                              │
│                                      │  └─ trace: traced() / step() │                              │
│                                      └──────────────────────────────┘                              │
│                                                      ▲                                             │
│                                                      │ consumes                                    │
│                                        ┌─────────────┴─────────────┐                               │
│                                        │                           │                               │
│                              ┌─────────────────┐          ┌───────────────┐                        │
│                              │ @hoplens/schema │          │  @hoplens/ui  │                        │
│                              │ (Zod static)    │          │ (single HTML) │                        │
│                              └─────────────────┘          └───────────────┘                        │
│                                                                                                    │
│   ┌───────────────────────┐    ┌───────────────┐                                                   │
│   │  @hoplens/transform   │    │ @hoplens/cli  │  bin `hoplens`                                    │
│   │  (fn rewrite + loader │    │ init/doctor/  │                                                   │
│   │   + register hook)    │    │ remove        │                                                   │
│   └───────────────────────┘    └───────────────┘                                                   │
│                                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Package roles

| Package | What lives here | Depends on |
|---|---|---|
| `@hoplens/core` | Runtime: capture, store, UI server, OTel bridge, source maps, redactor, trace helpers | `@opentelemetry/*`, `@hoplens/ui` |
| `@hoplens/schema` | Zod static interpreter (framework-neutral) and `SchemaProject` (schema finder + cross-file resolver shared by the Next and Express adapters); plug-in point for other validators later | `typescript` |
| `@hoplens/transform` | Exported-function rewriter (no line/column moves), webpack/Turbopack loader entry, Node ESM load hook (`register()` + `src/hooks.ts`, built to `dist/hooks.mjs`) and CommonJS layer (`src/cjs.ts`) | `typescript` |
| `@hoplens/ui` | Preact + signals, built by Vite to one inlined HTML file | — |
| `@hoplens/next` | `withHoplens()` config wrapper, Next route+proxy scanner (first `DiscoverySource` impl) | `@hoplens/core`, `@hoplens/schema`, `@hoplens/transform` |
| `@hoplens/express` | Express 4/5 adapter: register hook (`-r`/`--import`, plus the pre-boot function-hop shim in `src/autotrace.ts`) and `hoplens(app)`; CJS build plus a hand-written ESM wrapper (`esm/index.mjs` + `.d.mts`); Zod schemas linked from each route's registration call (`src/schemas.ts`, schema/transform required lazily on scan) | `@hoplens/core`, `@hoplens/schema`, `@hoplens/transform` |
| `@hoplens/cli` | bin `hoplens`: `init`, `doctor`, `remove` (also deletes `<distDir>/cache/hoplens`). Framework from package.json (`--framework` when both); Express edits only `scripts.dev`, in place (`src/json-edit.ts` keeps every other byte; `src/express/script.ts` inserts / removes one run of text so init -> remove is byte-exact) | `@hoplens/transform` (for TS loader) |
| `hoplens` (meta) | Unscoped meta — pulls in `@hoplens/cli` + `@hoplens/next` + `@hoplens/express` so `npm i -D hoplens` works (`hoplens/express`, `hoplens/express/register` re-export the adapter, kept external) | — |

### Composition seams

Two interfaces in `@hoplens/core` make the multi-framework story possible without touching core:

- **`DiscoverySource`** — `scan(): Discovery`. Each adapter ships one. Next walks the filesystem (`app/**/route.*`, `pages/api/**`), Nest will reflect decorators, Express will tap the router at install time (the route and mount tags in `packages/express/src/routes.ts` are the groundwork).
- **`HttpTap`** — tells core what to filter out (framework internals), what to classify as the "app's own" port, and how to recognise an in-flight request belongs to this framework.

The runtime never imports a framework. Adapters inject.

A third seam is internal: **`ApiModule`** (`packages/core/src/api/module.ts`). Every newer UI-server endpoint lives in its own `src/api/<name>.ts` exporting `endpoints` (and an optional `start(rt)` hook, run from `Runtime.start()`); `server.ts` lists it in `API_MODULES` and nothing else there changes.

### Core modules (`packages/core/src`)

Everything below `capture.ts` runs **after the response finished** (from `finalize()` or the store's `done` event) or on a UI-server request, never on the app's request path.

| Module | Role |
|---|---|
| `capture.ts` | http emit hook, OTel span processor, fetch / `pg` / redis patches, console capture, Server-Timing + `x-hoplens-trace` |
| `callsite.ts` | Caller frame of a wrapped function (the loop line of an N+1), captured only on the 2nd call under one parent |
| `facts.ts` | Per-trace facts: interval-union time buckets (`db cache ext fn framework compile idle`), TTFB, bytes, counts, cold; nested-fetch fold; URL normalization |
| `insights/` | Findings engine: `analyze.ts` runs each rule in `rules/` isolated; `thresholds.ts` holds the `insights` defaults |
| `store.ts` | Trace ring buffer, SSE events, manual and automatic pins |
| `stats.ts` | Per-route, per-epoch histograms, findings rollup, exemplars; outlives the ring |
| `queries.ts` | Cross-request query / host shapes |
| `query.ts` | Pure search grammar, shipped as `@hoplens/core/query` and bundled by the UI |
| `epoch.ts` · `sourcewatch.ts` · `importgraph.ts` · `chunkindex.ts` | Dev-rebuild epochs: the rebuild signal, which source files changed, which routes import them, and a module-level diff of the rebuilt chunks |
| `manifest.ts` | Epochs mode `"restart"` (Express under node --watch): token-normalized source hashes compared with the previous process's `sources.manifest` at start |
| `regressions.ts` | Per-route verdict per epoch on warm p50 over the URL variants both sides share |
| `compare.ts` | Span / shape / bucket / body diff of two traces |
| `replay.ts` | `POST /api/run?repeat=N` batches |
| `path/coverage.ts` · `path/capture.ts` · `api/path.ts` | Request path (opt-in `HOPLENS_PATH=1`, read at boot): V8 block coverage started by the Express register hook before any app module loads (`@hoplens/core/coverage`, its own entry; never stopped, refused under `NODE_V8_COVERAGE`), and the capture window behind `POST /api/traces/:id/path` (quiet gate, reset take, one replay, settle, take, hop vs coverage cross-check plus a per-block plausibility check, foreign start/update taint, one retry, a no-replay control window before blaming a local binding; error bodies `{ code, error }`) |
| `path/srcmap.ts` · `path/mapped.ts` · `path/generated.ts` · `path/scriptsource.ts` | Request path P5 (compiled code): the text V8 ran when it is not the file (kept by transform's loaders, `src/generated.ts`; opt-in Debugger read), its inline map's reverse index, and the node-for-node carry-over of the generated model's analysis to the raw file (see lesson #29) |
| `health.ts` | Event-loop delay, memory, GC, process errors |
| `persist.ts` | Opt-in NDJSON persistence of facts and summaries (`persist: true`) |
| `server.ts` · `api/*` | UI server and the loopback JSON API |

### UI (`packages/ui/src`)

`state/` holds pure logic plus signals (router, keymap, verdict, flame layout, compare, epochs, palette, …) and is where unit tests point; `components/` renders. The hash router (`state/router.ts`) is the only writer of `location.hash`. Every shortcut goes through `register()` in `state/keymap.ts`, which also feeds the `?` sheet, the action bar and the palette, so a key cannot be advertised without working. Colours and type come only from `styles/tokens.css` (enforced by `scripts/check-tokens.mjs`).

## Supported matrix (v0.1 target)

| | Next 16 | Next 15.3+ |
|---|---|---|
| Turbopack | full | everything except function hops (see lesson #6) |
| Webpack (`--webpack`) | full | full; middleware hops not available (edge sandbox) |

Node ≥ 20.9. App Router + Pages Router API routes. Edge runtime routes: listed, not traced.

## Hard-won lessons (DO NOT silently drop)

When refactoring a file called out below, re-read the matching lesson before changing the pointed-at lines.

1. **Next 16 loads instrumentation lazily** on the first request. That request misses the emit hook, so `withHoplens` adds a `/__hoplens` rewrite to the standalone port as a fallback. → `packages/next/src/index.ts` (rewrites block).
2. **Next creates several OTel root traces per request** (outer `BaseServer.handleRequest` with `next.bubble`, the inner one with `next.route`, `Middleware.execute` separately). Correlate with our own `AsyncLocalStorage`, not trace ids. Drop the `next.bubble` span. → `packages/core/src/capture.ts` (classify()).
3. **Span types used:** `Middleware.execute` (proxy), `BaseServer.handleRequest` (request), `AppRouteRouteHandlers.runHandler` and "executing api route (pages)" (handler), `AppRender.fetch` (fetch), `NextNodeServer.startResponse` (response marker), `findPageComponents / loadRouteModule / RouteModule.prepare / AppRouteRouteModule.loadUserland` (router, includes dev compile time). → `packages/core/src/capture.ts`.
4. **Next 15 reports `next.route` as `/api/x/route`**; strip `/route`. → `packages/core/src/capture.ts` (finalize()).
5. **TypeScript 7 (now npm `latest`) has no JS API.** Ship our own TypeScript 5/6 as a dependency and prefer it over the project's copy; validate `typeof ts.createSourceFile === "function"`. → `packages/transform/src/ts.ts`.
6. **Turbopack on Next 15.5 fails when running webpack loaders** (internal `TP1006` lint error), so only register the Turbopack rule on Next ≥ 16; tell users to use `--webpack` on 15. → `packages/next/src/index.ts` (`nextMajor()` guard).
7. **Webpack dev uses `eval-source-map`:** frames look like `webpack-internal:///(rsc)/./src/x.ts:48:40` with generated line numbers. Map them by scanning `<distDir>/dev/server` (Next 16) or `<distDir>/server` for inline `sourceMappingURL=data:` next to the `sourceURL`, throttled. → `packages/core/src/sourcemap.ts`.
8. **Turbopack maps are sectioned**; Node's `module.SourceMap` handles them. Framework frames point at sources not on disk: keep the shipped path, mark as framework. → `packages/core/src/sourcemap.ts`.
9. **Next 15 starts the server before evaluating `next.config`**, so env vars set in `withHoplens` don't reach it; also write options to `<distDir>/cache/hoplens.json`. → `packages/next/src/index.ts` + `packages/core/src/runtime.ts`.
10. **Next 16 renamed middleware to `proxy.ts`** and runs it on Node, so it's traceable; Next 15 middleware runs in the edge sandbox and isn't. → `packages/next/src/routes.ts` (findProxy()).
11. **SVG elements have no `.hidden` property**; toggle the attribute. → `packages/ui/index.html`.
12. **Don't depend on Google Fonts or any CDN** in the UI; sandboxed and offline dev environments block them, and a local tool shouldn't phone home. → `packages/ui/`.
13. **Killing dev servers in scripts:** `pkill -f "next dev"` also matches your own shell; start servers with `setsid` and kill the process group.
14. **The 500 from a thrown route error has an empty body in dev**; the UI explains that the error lives in the journey. → `packages/ui/` + `packages/core/src/capture.ts`.
15. **Turbopack rewrites chunk files in place**, so no directory mtime moves on an edit, while Next rewrites `*manifest*` files and touches `app/<route>` dirs with no edit at all. The rebuild probe counts only non-manifest `.js` writes, and a first-ever compile of a route (plus a settle window after it) is absorbed instead of bumping the epoch. → `packages/core/src/epoch.ts` (header).
16. **A formatter-only save is not an edit.** Turbopack skips unchanged writes, and a rewrite with identical module code is caught by hashing each module with its `sourceMappingURL` and chunk scaffolding stripped. Next builds some `node_modules` modules twice under one id (pnpm peer variants of `next`), so a new hash there counts as added, not edited. → `packages/core/src/chunkindex.ts`.
17. **Next 15 dev writes `<distDir>/server` itself**, so "no dev dir" doesn't mean production. The chunk index is skipped on `NODE_ENV=production` instead. → `packages/core/src/epoch.ts` (`createEpochTracker`).
18. **`fs.watch` on Windows** reports an overflowing burst (a checkout, a codemod) as one event with no filename, and misses some Turbopack writes. A nameless event triggers a rescan; each chunk update also sweeps route entries whose mtime moved. Never `return` early on a null filename. → `packages/core/src/sourcewatch.ts`, `epoch.ts`, `chunkindex.ts`.
19. **Next and Hoplens both wrap `fetch`**, so one outgoing call is a fetch span with a fetch child for the same method + URL. `foldNestedFetches()` folds the pair (Next's timing, our name/attrs/location) before facts and rules run, or every count and finding doubles. → `packages/core/src/facts.ts`.
20. **`pg.Pool.query` always calls `client.query` in callback form**, which returns `undefined`. End the span in the wrapped callback, not when `query()` returns, or every pooled query reads ~0ms with no row count. → `packages/core/src/capture.ts` (pg patch).
21. **Windows timers are coarse.** Back-to-back awaits overlap by 1-2ms, so the parallelizable rule treats an overlap up to max(2ms, 15% of the shorter call) as sequential. The event-loop histogram includes the sampler's own interval (rounded up to the 15.625ms tick on win32), so `loopFloorMs` subtracts it or an idle loop reads 20-30ms. → `packages/core/src/insights/rules/parallel.ts` (`follows`), `packages/core/src/health.ts`.
22. **Headers passed to `res.writeHead()` win over `setHeader()`** in Node. Server-Timing extends a `server-timing` given there in a copy of that argument and appends to an existing value, never overwriting it. → `packages/core/src/capture.ts` (Server-Timing block).
23. **Request-path work is measured, not assumed.** Facts, findings, stats and persistence run after the response; the bench gates the whole pipeline at < 2ms. Call-site capture keeps a few structured V8 frames only on the 2nd call of a wrapped function under one parent (an N+1 needs repeats), and `.stack` is formatted lazily after the response. → `packages/core/src/callsite.ts`, `test/benchmark.test.ts`.
24. **Persistence never writes free text.** Finding titles that quote a log line or an error message are rebuilt without it, and URL query values are masked unless they match `^[\w.-]{0,8}$`. → `packages/core/src/persist.ts` (`persistedTitle`, `persistedUrl`).
25. **The request log is windowed** (visible rows plus overscan). DOM order of `[data-trace-id]` is not screen order, so a probe for "the row under the pointer stays put" must use `elementFromPoint`. → `packages/ui/src/components/RequestLog.tsx`.
26. **Express 4 binds `Route#dispatch` when a route is created** (`route.dispatch.bind(route)` in `Router#route`), so the dispatch patch must be on `Route.prototype` before user code registers a route: the register hook installs the route patches at load (it requires the app's express from its root, not `@hoplens/core`). Express 5 (`router` 2.x) calls `route.dispatch` per request. `hoplens(app)` rebinds the v4 route layers it finds. Never read `app.router` on 4 (a throwing deprecation getter); its stack is `app._router.stack`. Layers keep no mount path string, so `use()` is patched to tag them, and `next()` from a handler runs in the hop's parent context (`HopHandle.exit`) so the next route's hop is a sibling. → `packages/express/src/routes.ts`.

27. **A watch restart is the edit signal for Express.** node --watch / tsx watch / nodemon kill the process on every save, without running `exit` handlers (SIGTERM, TerminateProcess on Windows), so in epochs mode `"restart"` the persister flushes every 250ms and the restart epoch row is flushed *before* the new `sources.manifest` is renamed into place (a kill in between re-finds the edit instead of losing it; a failed flush defers the manifest write to the next good one). Sources are compared by TypeScript scanner tokens (trivia, quotes, trailing commas dropped; a statement end is one token whether `;` or an ASI line break, so `return\nx` and a dropped `;` before `(` still count); a `/` after an unsure token is rescanned as a regex, since a regex misread as division lets a `//` inside it hide the rest of the line. In `.jsx`/`.tsx` comment text counts (the plain scanner reads `<a>http://x</a>` as a comment). A file whose size+mtime match the manifest is only stat'ed; TypeScript is loaded only when some file's bytes changed. The manifest is not `.json` (nodemon restarts on `.json`) and is not rewritten when nothing changed; a `.json` under a source dir that no module imports and that changed since the last start (an app-written store) is no edit. A restart edit reached through `app.js`'s own import (middleware) maps to every router `app.js` mounts too. node --watch waits for the old process to exit before starting the new one (the UI port is free again); `samePortRetryMs` keeps the UI on its port for a runner that does not. → `packages/core/src/manifest.ts`, `runtime.ts` (`startPersistence`, `listen`).

28. **Function hops outside Next need a global before boot.** The transform trailer reads `globalThis.__hoplens.wrap` once, when its module evaluates, and the real wrap only exists after `Runtime.start()` (the Express adapter boots at the first `listen()`). So the register hook installs a core-free shim first (forwarders that bind once to core's wrap in `bindFnShim()`, right after `rt.start()`), and `(req, res[, next])` / `(err, req, res, next)` calls pass through it unwrapped (they have handler hops; `traced()` wraps, with line 0, are not guarded). The ESM hook rewrites a source byte-identical to the file on disk (RAW). With tsx first (`tsx [watch] --import hoplens`, `--import tsx --import hoplens`: the hook registered last runs first, so ours gets tsx's output) a `.ts`/`.mts` file goes through COMPILED mode (`transformCompiled`): the raw file from disk is parsed for targets and lines, each target is found in esbuild's output by its *exported* name (locals can be renamed) as exactly one top-level `function`/`const|let|var` binding of the same kind and async-ness (`__name()` allowed; a `var` nested in a top-level block, as esbuild's `using` lowering emits, blocks the name), and only the trailer is appended after tsx's `//# sourceMappingURL` comment (Node takes the last such comment, so the map and every stack line:col stay valid). Any mismatch refuses the whole file (`unmapped`); any other changed source is refused (`compiled`), never rewritten. Fixtures under `packages/transform/test/fixture/tsx` are real tsx output named by version; the drift test recompiles them with the installed tsx. Under `-r` Node runs the preload again inside the module hooks worker, so registration bails off the main thread (or the hook chains twice). Under `preset: "node"` a file with parse errors is left alone, or the appended trailer changes its SyntaxError. The trailer rebinds after the module body ran, so under `node` a target the module uses as a value (`bus.on(x, f)`, `{ f }`, `export default f`, `new f()`), one using `this`, or one calling itself is skipped (identity checks and recursion depth must match the unwrapped app); the shim calls the function directly on re-entry. core's `preview()` must never run app code (no getters, no Proxy traps) and a decorated promise comes back as the same object. CommonJS (`src/cjs.ts`): a wrapper on `Module._extensions` (`.js` `.cjs` `.ts` `.cts`, only handlers that exist; Node 22 has no `.cjs`/`.ts` key and routes them through `.js`) re-heals on every `Module._load`, so it stays outermost over tsx / ts-node and sees the raw file; it hands the inner handler the transformed source by swapping `fs.readFileSync` for that one resolved filename, only between the handler call and its `module._compile` (an own property on that module object, never `Module.prototype._compile`), restored in `finally` (the module body and everything it requires already run inside the handler, so a handler-long swap would leak into them). The transform runs only on that read: Node's ESM translator (an `--import` CommonJS entry, a `.cjs` imported from ESM) has already read the source and never reads again, so those files are reported `esm-loader`, not parsed. The CommonJS trailer rebinds the *exports property* only when it is an own writable data property holding a function (getters, frozen, `module.exports = f` untouched, never throws); calls through the local binding stay unwrapped. A `.js` with `import`/`export` syntax is left to the ESM path; `.ts`/`.cts` with `export` syntax gets the ESM trailer and the loader compiles it. Use `__dirname` checks so the layer never inspects Hoplens' own dist (requiring the transform from inside the handler recursed). Healing must stay bounded: read the slot back after assigning, and a value that is not our wrapper (append-transform's accessor wraps every assigned handler) is remembered and never wrapped again, or each `require` adds frames. The `fs.readFileSync` swap captures its previous read only when it is not already in the chain: a patcher that wrapped it during a swap holds ours as its previous, so ours stays buried under it for good (re-capturing that patcher looped every read into a RangeError); a nested call reads through the install-time original. The CommonJS skip rules mirror the ESM ones: a function calling itself through its own export (`exports.f()`, tsc's `(0, exports.f)()`, `this.f()` in a method) is skipped, one function under two keys shares one wrapper, and `.ts`/`.cts` trailers get a `// @ts-ignore` line (ts-node type-checks what it is handed). `.cts` (or `.ts` in a CommonJS package) under `--import` reaches the ESM hook with Node's own read as `commonjs-typescript` and is wrapped there when it equals the disk bytes. → `packages/express/src/autotrace.ts`, `packages/transform/src/hooks.ts`, `register.ts`, `cjs.ts`.

29. **Coverage offsets are into the text V8 ran.** Plain JS and Node's type stripping (types become spaces; Node appends a `//# sourceURL`) are identity. tsx's output is not: it is one minified line, inlines enums, drops dead statements (`void 0;`), and its map's `sourcesContent` is null. So the truth model never reads mapped offsets: it runs on the GENERATED text's own CFG (identity, what V8's ranges are shaped by: tsx merges ranges the stripped file keeps apart), and `mapped.ts` carries the result to the raw file only when the two CFGs match node for node with every executable node's map anchors inside the paired raw node (blocks unchecked: esbuild maps a finally's `{` to `finally`; bare break/continue may have none; a pretty-printed statement is anchored on its indentation; `__name(f, "f")` maps back to `f`, so anchors are not monotonic inside one node). The generated text must come from what V8 ran: the ESM hook posts its COMPILED-mode output from the hooks worker (async, via the port), the CommonJS layer keeps what `module._compile` got; only text with an inline map is kept (stripped CommonJS has none and stays identity). With tsx registered after Hoplens our hook never sees tsx's output: `module.findSourceMap` (tsx enables maps) says the script is compiled, so it is UNKNOWN `no-generated-text` unless `HOPLENS_PATH_DEBUGGER=1` (the reason names what the process can tell: loaders off, a size cap, Node's own `--experimental-transform-types`, else the loader order; look the map up by V8's script URL first, Node's map cache is exact-match down to the drive letter's case). The Debugger read's session is opened once and never disabled or disconnected: `Debugger.disable` (a disconnect too) drops V8's block counters for every compiled function and coverage falls back to function counts for good. Arms and cases are checked against the PAIRED raw arm / case, each up to the next one: a full minifier inverts `!(a > 0) ? f1() : f2()` into `a>0?f2():f1()` with the same shape (esbuild maps the indentation before a `case` to the token before it, so arms and cases take no leading trivia). A file saved with a BOM: `import` drops it from V8's text, `require` keeps it, and every offset moves with it; the module function's length (when the take has it) or the function ranges (V8's start and end on a token) decide, else UNKNOWN. esbuild's CommonJS output names an export getter after the export (`rank: () => rank`): pick functions by hop line, never by name alone. → `packages/core/src/path/mapped.ts`, `srcmap.ts`, `generated.ts`, `capture.ts` (`scriptJoin`), `analyze.ts` (`analyzeMapped`), `packages/transform/src/generated.ts`, `hooks.ts`, `cjs.ts`.

## Working rules (from the project brief)

- **Plan first.** Each phase ends with: what changed, how verified, what's left.
- **Verify everything.** Tests back every "it works" claim. Never mark done with failing tests.
- **No silent scope cuts.** If a spec item is wrong, surface it before changing course.
- **Complete files.** When showing code, show whole files.
- **Zero prod impact.** Assert in tests. `TRACEPATH_FORCE=1` style escape hatch becomes `HOPLENS_FORCE=1`.
- **Overhead budget in dev:** < 2 ms per request without function hops, < 0.1 ms per wrapped call outside a request.
- **No network calls from the UI or runtime** other than to the user's own app.
- **Loopback-only** UI/API by default; `allowRemote: true` to open up.
- **Loader must never move a line.** Snapshot tests prove this in Phase 3.

## Pre-release reminders

- [ ] **Claim the `@hoplens` npm org** before Phase 7 so no one else does.
- [ ] Grab `hoplens.dev` at a registrar (Cloudflare / Porkbun — cost-price for `.dev`).
- [ ] npm 2FA / tokens — review publishing restrictions landing Aug 2026 / Jan 2027 before shipping.
