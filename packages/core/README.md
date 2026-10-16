# @hoplens/core

Framework-agnostic runtime for [Hoplens](https://github.com/hermandinho/hoplens).
Captures HTTP requests via `http.Server.prototype.emit`, correlates spans with
`AsyncLocalStorage`, bridges to OpenTelemetry as a reader (never replaces an
existing provider), and serves the UI on a free loopback port.

After each response it computes the request's facts (where the time went,
sizes, cold/compile) and findings (N+1, duplicates, parallelizable chains,
slow functions, uncached fetches, cold compiles, large payloads, swallowed
errors, logs on a success), off the request path. It keeps per-route stats,
query shapes, dev-rebuild edits with regression verdicts and process health,
and serves them as a loopback JSON API under `/__hoplens/api`. The options,
the query language and the endpoints are documented in the
[repo README](https://github.com/hermandinho/hoplens#readme).

Subpaths:

- `@hoplens/core/trace` — `traced()`, `step()` and `drizzleLogger()` for code
  the auto-tracer can't reach. No-ops when the runtime isn't loaded.
- `@hoplens/core/query` — the pure trace search grammar (`parseQuery`,
  `matchQuery`, `compileGlob`), shared with the UI.

Internal — pulled in by adapters like
[`@hoplens/next`](https://www.npmjs.com/package/@hoplens/next). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) instead.
