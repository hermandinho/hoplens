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
| `@hoplens/schema` | Zod static interpreter (framework-neutral); plug-in point for other validators later | `typescript` |
| `@hoplens/transform` | Exported-function rewriter (no line/column moves), webpack/Turbopack loader entry, Node `register()` hook stub | `typescript` |
| `@hoplens/ui` | Preact + signals, built by Vite to one inlined HTML file | — |
| `@hoplens/next` | `withHoplens()` config wrapper, Next route+proxy scanner (first `DiscoverySource` impl) | `@hoplens/core`, `@hoplens/schema`, `@hoplens/transform` |
| `@hoplens/express` | Express 4/5 adapter: register hook (`-r`/`--import`) and `hoplens(app)`; CJS build plus a hand-written ESM wrapper (`esm/index.mjs` + `.d.mts`) | `@hoplens/core` |
| `@hoplens/cli` | bin `hoplens`: `init`, `doctor`, `remove` (also deletes `<distDir>/cache/hoplens`) | `@hoplens/transform` (for TS loader) |
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
| `regressions.ts` | Per-route verdict per epoch on warm p50 over the URL variants both sides share |
| `compare.ts` | Span / shape / bucket / body diff of two traces |
| `replay.ts` | `POST /api/run?repeat=N` batches |
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
