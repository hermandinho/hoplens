---
"hoplens": minor
"@hoplens/core": minor
"@hoplens/next": minor
"@hoplens/ui": patch
---

postgres.js (`postgres`) queries show up in the journey with no setup, Drizzle's
`drizzle-orm/postgres-js` included. Each query is a `postgres.query` db span
with its real duration, the SQL as sent, redacted bound params, the row count
and the call site of a tagged-template query. The driver's own queries
(array-type fetch, session state) are left out, and so are cursors and
`COPY` streams.

Under Next, `withHoplens` adds `postgres` to `serverExternalPackages` in dev
when the app can resolve it, because a bundled copy can't be instrumented. It
skips this when `postgres` is in `transpilePackages`.
