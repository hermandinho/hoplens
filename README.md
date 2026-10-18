<img src="assets/logo-mark.svg" alt="Hoplens logo" width="64" height="64">

# Hoplens

[![npm](https://img.shields.io/npm/v/hoplens.svg)](https://www.npmjs.com/package/hoplens)
[![ci](https://github.com/hermandinho/hoplens/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hermandinho/hoplens/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/hoplens.svg)](./LICENSE)

> One command, and `next dev` gains a page that shows every request's full
> hop-by-hop journey — proxy → router → handler → your functions → fetch/DB
> → response — opens each one with a sentence saying what made it slow or
> fail and where, and tells you whether your last edit made a route slower.

![Hoplens UI showing a trace journey](./e2e/snapshots/screenshots.spec.ts-snapshots/desktop-1600-with-trace-desktop-1600-win32.png)

## Install

```bash
npm i -D hoplens
npx hoplens init     # wires withHoplens() + instrumentation.register()
npm run dev
# open http://localhost:3000/__hoplens
```

Requires Next.js 15.3+ and Node 20.9+. Next 16 is the primary target.

Express 4 or 5? The same `npx hoplens init` adds `--import hoplens/express/register` to your
`dev` script (see [`@hoplens/express`](./packages/express/README.md)); then run it and open
`http://localhost:<your port>/__hoplens`.

## What you get

- **The whole journey.** Every request becomes a tree of hops: proxy,
  router, dev compile, your handler, each exported function it calls,
  outbound `fetch`, DB and Redis calls, the response. Timings, args, return
  values and logs on one canvas, as a Tree or a Flame graph with a minimap,
  the critical path and idle gaps.
- **Cause first.** Each request opens with one verdict sentence: what made it
  slow or fail, roughly how much fixing it would save, and the line to look
  at. N+1 loops point at the call inside the loop, errors caught inside a
  `200` read "Failed silently", a cold request names its compile wait.
- **Findings across requests.** Nine rules (N+1, duplicate calls,
  parallelizable chains, slow functions, uncached fetches, cold compiles,
  large payloads, swallowed errors, warn/error logs on a success) run after
  each response. The Overview ranks them by saveable ms per request ×
  requests and leads with the top one.
- **Did my edit make it worse?** Every dev rebuild is an edit, attributed to
  the files you saved and the routes they reach. Changes lists each edit with
  a per-route verdict (warm p50 on the same URLs, before vs after), and a
  toast names a route that just got slower.
- **Compare and replay.** Diff two requests span by span (`x10 → x1`), with
  the time buckets, findings and bodies side by side. Replay a request once
  or ×10 for a warm p50/p95 against the previous batch.
- **Errors pinned to the line.** Thrown errors carry the `.ts` line and the
  mapped stack; the source opens inline, no IDE round-trip. Uncaught
  exceptions and unhandled rejections in the dev server are collected too,
  next to event-loop delay and memory in the top bar.
- **Request builder with static Zod pre-fill.** Hoplens reads your `z.*`
  schemas from source (no code execution) and pre-fills example bodies for
  every route.
- **In your browser's Network panel.** Dev responses carry a `Server-Timing`
  header (db, cache, ext, fn, compile, total) and `x-hoplens-trace: <id>`.
- **OpenTelemetry-native.** If you already run OTel, Hoplens attaches as a
  reader — it doesn't replace your provider. If you don't, Hoplens runs
  standalone.
- **Dev-only, guaranteed.** The instrumentation hook is gated by
  `NODE_ENV === "development"` and the production build is CI-asserted to
  contain zero Hoplens runtime.

## The UI

Four views, each a list beside the thing you picked. On phones (≤ 760px) the
list and the subject are separate pages with bottom tabs. The URL hash holds
the state, so every screen has a link and Back / Forward work.

| View | Shows | Link |
|---|---|---|
| **Overview** | The top problem in one sentence, the next findings, routes by time spent with a per-edit p50 delta, and one errors line (5xx / thrown / swallowed). A route opens with fast / typical / slow example requests. | `#/`, `#/route/<key>` |
| **Requests** | The live request log with a query bar (see [Search](#search)). An open request shows its verdict, where to look, the time budget, the canvas and Response / Request / Console / Span details. | `#/requests`, `#/r/<id>[/s/<span>]` |
| **Queries** | Every db, cache and fetch call shape across requests: calls, total, p95, errors, the routes and functions that call it, loop counts. Fetches can be grouped by host. | `#/queries`, `#/q/<shape>` |
| **Changes** | A timeline of your edits (dev rebuilds) with one dot per request, the files saved, the routes affected and a verdict per route. | `#/changes[/e<n>]` |

Compare opens at `#/cmp/<a>..<b>`. Any view takes `?since=e<n>`, which scopes
it to that edit and later, shown as a chip you can clear.

### Keyboard

Press `?` for the keys that work where you are, and `Ctrl+K` (`Cmd+K` on mac)
for the command palette: findings, routes, recent requests, query shapes,
edits, views and actions, matched fuzzily (the server search also covers logs
and bodies). Enter runs a row's main action, `Ctrl/Cmd+Enter` its secondary
one.

| Where | Key | Does |
|---|---|---|
| anywhere | `1` `2` `3` `4` | Overview, Requests, Queries, Changes |
| | `/` | Filter the request list |
| | `b` | Open / close the request builder |
| | `s` · `e` · `E` | Toggle the since-last-edit scope · scope to an older · a newer edit |
| | `Ctrl+\` | Collapse / expand the list |
| | `Esc` | Close the drawer, then clear the filter or scope, then close the subject |
| lists | `j` / `k` | Next / previous row (the open subject follows) |
| | `Enter` · `Space` | Open · peek the request under the cursor |
| a request | `[` / `]` | Newer / older request |
| | `f` · `o` | Highlight the verdict's cause · open the culprit's source |
| | `c` · `c c` · `d` | Compare with the default baseline · pick the baseline · diff against the previous build |
| | `p` | Pin it (kept past the ring buffer) |
| | `r` · `R` | Replay once · ×10 |
| | `y` | Copy as curl, `fetch()` or a Vitest test |
| | `t` · `z` · `0` | Tree / flame · zoom to the selection (or the handler) · reset zoom |
| the canvas | `[` / `]` · `/` · `n` / `N` | Pan · search spans · next / previous match |

On touch phones the key hints are hidden.

## Options

`withHoplens()` takes your Next config and, optionally, Hoplens options:

```ts
// next.config.ts
import { withHoplens } from "hoplens/next";

export default withHoplens(
  { /* your Next.js config */ },
  {
    insights: { thresholds: { nPlusOneMin: 10 }, disable: ["logs-on-success"] },
    persist: true,
  },
);
```

| Option | Default | What it does |
|---|---|---|
| `enabled` | on in dev | `false` (or `HOPLENS=0`) turns Hoplens off. |
| `port` | `4983` | Standalone UI port (also `HOPLENS_PORT`; the next ports are tried if it is taken). The UI is always at `/__hoplens` on your dev server too. |
| `autoTrace` | `true` | Wrap exported functions in your modules as hops. Pass `{ include, exclude }` globs to narrow it, or `false`. |
| `redact` | — | Keys masked in headers, bodies, args and results, on top of the built-in list (authorization, cookie, password, token, api_key, …). |
| `profiles` | — | Header presets for the request builder; `${ENV_VAR}` is replaced at send time. |
| `maxTraces` | `300` | Traces kept in memory. Route stats and query shapes outlive the ring. |
| `insights` | all rules on | `thresholds` overrides any of `nPlusOneMin` (5), `duplicateMin` (2), `parallelMinMs` (10), `parallelMaxGapMs` (15), `parallelMinRun` (3), `slowFnMs` (100), `slowFnShare` (0.5), `slowFnMinTraceMs` (20), `slowFnShareMinMs` (50), `coldCompileMs` (300), `largePayloadBytes` (1 MiB). `disable` takes rule ids: `n-plus-1`, `duplicate`, `parallelizable`, `slow-fn`, `fetch-uncached`, `cold-compile`, `large-payload`, `swallowed-error`, `logs-on-success`. |
| `serverTiming` | `true` | Add `Server-Timing` and `x-hoplens-trace` to traced dev responses. Appended to an existing `Server-Timing`, never overwriting it, and never added when `NODE_ENV=production`. Streamed responses get the numbers known when headers flush. |
| `persist` | `false` | Keep route stats, edits and regression verdicts across dev restarts (see below). |
| `lateSpanGraceMs` | `40` | How long to wait after the response for spans that end late. |
| `allowRemote` | `false` | Serve the UI to non-loopback clients. |

### Persistence

With `persist: true`, Hoplens appends facts and summaries as NDJSON under
`<distDir>/cache/hoplens` (at most two files of 5 MB), so the Overview's route
stats, the Changes timeline and its regression verdicts survive a dev restart.
Request and response bodies, headers, spans, logs and error messages are never
written. Finding titles that quote a log line or an error message are stored
without the text, and URL query values are masked unless short and plain.
`hoplens remove` deletes the folder.

## Search

The request list's query bar (and `GET /__hoplens/api/traces?q=`) takes terms
that are AND-ed; a leading `-` negates any term:

```text
status:5xx  status:404  status:>=400  status:400..499  status:404,500
dur:>200  dur:<=50ms  dur:>1.5s  dur:100..500        (bare number = at least)
route:/api/*  route:/api/orders                       (glob; no * = exact or prefix)
method:POST  method:get,put     kind:route  kind:page,action
has:n+1  has:error  has:findings  has:<rule id>       cold:true  cold:false
timeout  "connection refused"  text:"upstream 503"    (free text; the server also searches logs and bodies)
-status:2xx  -"health"
```

The grammar ships as the pure `@hoplens/core/query` subpath (`parseQuery`,
`matchQuery`, `compileGlob`).

## Instrumentation

Out of the box: Next's own OTel spans, your exported functions (via the
loader), `globalThis.fetch` (with Next data-cache and CDN cache attribution),
`pg` (node-postgres, `Pool` included), `postgres` (postgres.js, resolvable from
the app root), `ioredis` and `node-redis` v4+, Prisma
with its OTel instrumentation, and any OTel span with `db.*` attributes. For
code the loader can't reach:

```ts
import { traced, step } from "hoplens/trace";

export const charge = traced("stripe.charge", (amount: number) => stripe.charges.create({ amount }));
await step("send welcome email", () => mailer.send(user));
```

Drizzle users can also pass `drizzleLogger()` from `@hoplens/core/trace` as
the Drizzle logger. All three helpers do nothing when the runtime isn't
loaded, so they are safe in production code.

## HTTP API

Everything the UI shows comes from a loopback JSON API under
`/__hoplens/api` (also on the standalone port), handy for scripts and tests.

| Endpoint | Returns |
|---|---|
| `GET /traces[?q=&since=]` · `GET /traces/:id` · `DELETE /traces` | Trace summaries, filtered by a query and/or an edit · one full trace · clear all |
| `GET /stats[?buckets=1&since=]` | Per-route latency histograms, the findings rollup, error kinds, per-edit p50 deltas, example requests |
| `GET /queries[?kind=db\|cache\|fetch]` | Normalized query and host shapes with calls, p95, errors, routes and callers |
| `GET /compare?a=&b=` · `/compare/baselines` · `/compare/pins` | Span-level diff of two traces · baseline candidates · pins (`POST` / `DELETE /compare/pins/:id`) |
| `GET /epochs` · `/regressions` · `/epochs/events` (SSE) | Edits with files and affected routes · per-route verdicts · live feed |
| `GET /health` · `/health/stream` (SSE) | Event-loop delay, memory, GC and recorded process errors |
| `POST /run[?repeat=N]` | Send a request through your app; `repeat` (up to 50) runs it in sequence and reports warm p50/p95 against the last batch |
| `GET /events` (SSE) | `start` / `done` / `update` / `clear` per trace, plus `health` ticks |
| `GET /routes` · `/meta` · `/source?file=&line=` | Discovered routes · runtime info · a source excerpt |

## Commands

```text
hoplens init     wire Hoplens into next.config and instrumentation (or the Express dev script)
hoplens doctor   check that everything is wired correctly
hoplens remove   unwire Hoplens from this project (reverse of init)
```

`init` and `remove` support `--dry-run` (`doctor` never writes). All three work on Next.js and
Express projects: the framework is detected from `package.json` (pass `--framework next|express`
when a project depends on both). For Express,
`init` edits only `scripts.dev` (adding `--import hoplens/express/register` after `node`, `tsx` or
`nodemon`), `doctor` checks the install and wiring, and `remove` puts the script back byte for byte.
Run `npx hoplens <cmd> --help` for details.

## Monorepo layout

```
packages/
  meta/        hoplens              unscoped meta — depends on cli, next, core
  cli/         @hoplens/cli         bin `hoplens` (init / doctor / remove)
  next/        @hoplens/next        withHoplens, Next route scanner, proxy detect
  core/        @hoplens/core        framework-agnostic runtime, OTel bridge, findings, API
  schema/      @hoplens/schema      static Zod reader
  transform/   @hoplens/transform   exported-fn rewriter + loader + register hook
  ui/          @hoplens/ui          Preact + Vite single-HTML dashboard
examples/
  next16-app/                       Turbopack + proxy.ts + Zod v4 + pg, with seeded problems
  express-app/                      Express 5 (ESM) + pg + Zod v4 via hoplens/express/register, with seeded problems
e2e/                                Playwright suite + install-flow smoke
```

See [`AGENTS.md`](./AGENTS.md) for architecture notes and the lessons that
shaped the design.

## Development

```bash
pnpm install
pnpm build                                 # every package under packages/
pnpm test
pnpm typecheck
pnpm lint
pnpm --filter @hoplens/core bench          # the per-request pipeline must stay under 2 ms
pnpm --filter example-next16-app dev       # try the UI against the live example
pnpm --filter example-express-app dev      # the Express example, http://localhost:3100/__hoplens
```

End-to-end checks (opt-in, slow):

```bash
pnpm --filter hoplens-e2e install:browsers   # one-time
pnpm --filter hoplens-e2e e2e                # Playwright screenshot suite
pnpm --filter hoplens-e2e verify:build       # prod build has no Hoplens leaks
pnpm --filter hoplens-e2e verify:install     # pack → scratch install → init → doctor
```

## License

MIT © Hoplens contributors. See [LICENSE](./LICENSE).
