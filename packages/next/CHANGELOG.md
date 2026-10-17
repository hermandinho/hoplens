# @hoplens/next

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

## 0.2.0

### Patch Changes

- Updated dependencies [5bf7200]
- Updated dependencies [5bf7200]
  - @hoplens/core@0.2.0
