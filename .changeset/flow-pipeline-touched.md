---
"hoplens": minor
"@hoplens/core": minor
"@hoplens/ui": minor
---

Rebuild the Flow view so it reflects what the request actually did, not a
straight timeline. Two sections now:

- **Pipeline** on top — `Client → Middleware → Router → Handler → Response`
  with each node showing kind, source file:line, and its own duration.
  Errored nodes are tinted red. Click a node to inspect it.
- **Touched** grid below — one card per resource category the handler hit,
  with per-call rows and durations:
  - **Databases** grouped by system (PostgreSQL, MySQL, MongoDB, …), with
    the operation + inferred table on each row.
  - **Cache** group (Redis, Memcached) with the command + key on each row.
  - **External APIs** grouped by host; shows method, path, and cache-hit
    signal when the response advertised one.
  - **Internal functions** grouped by directory.
  - **Render** group for RSC spans.
- A header strip chips the totals per category so you can see where the
  budget went at a glance.

Plus **Redis instrumentation** — both `ioredis` and `node-redis` v4+ are
auto-patched when installed in your app. Every command becomes a `db`
span with `db.system: redis`, the command, redacted args, and the key.
Combined with the existing `pg` instrumentation, this means Drizzle +
Prisma + raw-pg + ioredis users all see their calls in the Touched grid
with zero config.
