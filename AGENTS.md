# Hoplens working notes

Operating guide for anyone (human or agent) touching this repo. Keep this file current.

## Commands

```bash
# install everything, link workspace packages
pnpm install

# build all publishable packages (packages/*)
pnpm -r build

# strict typecheck, in parallel
pnpm -r typecheck

# vitest in every package that has tests
pnpm -r test

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
| `@hoplens/ui` | Single inlined HTML (Preact rebuild = Phase 4) | — |
| `@hoplens/next` | `withHoplens()` config wrapper, Next route+proxy scanner (first `DiscoverySource` impl) | `@hoplens/core`, `@hoplens/schema`, `@hoplens/transform` |
| `@hoplens/cli` | bin `hoplens`: `init` (and later `doctor`/`remove`) | `@hoplens/transform` (for TS loader) |
| `hoplens` (meta) | Unscoped meta — pulls in `@hoplens/cli` + `@hoplens/next` so `npm i -D hoplens` works | — |

### Composition seams

Two interfaces in `@hoplens/core` make the multi-framework story possible without touching core:

- **`DiscoverySource`** — `scan(): Discovery`. Each adapter ships one. Next walks the filesystem (`app/**/route.*`, `pages/api/**`), Nest will reflect decorators, Express will tap the router at install time.
- **`HttpTap`** — tells core what to filter out (framework internals), what to classify as the "app's own" port, and how to recognise an in-flight request belongs to this framework.

The runtime never imports a framework. Adapters inject.

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
