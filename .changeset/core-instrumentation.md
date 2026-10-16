---
"hoplens": minor
"@hoplens/core": minor
---

Deeper capture: outgoing calls, databases and caches show up in the journey
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
