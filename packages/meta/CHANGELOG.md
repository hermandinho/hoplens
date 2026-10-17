# hoplens

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
