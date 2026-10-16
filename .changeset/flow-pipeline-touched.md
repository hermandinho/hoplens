---
"hoplens": minor
"@hoplens/core": minor
---

**Redis instrumentation**: both `ioredis` and `node-redis` v4+ are
auto-patched when installed in your app. Every command becomes a `cache`
span with `db.system: redis`, the command, redacted args, the key, its
duration, hit/miss for reads and the value size. Combined with the
existing `pg` instrumentation, Drizzle, Prisma, raw-pg and ioredis users
all see their calls in the journey and the Queries view with zero config.
