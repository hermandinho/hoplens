---
"@hoplens/core": minor
---

Every finished request now explains itself, and the runtime keeps what it
learns across requests, edits and (optionally) restarts. All of it runs after
the response, off the request path; the per-request pipeline is gated at
under 2 ms by `pnpm --filter @hoplens/core bench`.

**Facts** (`trace.facts`): where the time went, as interval-union self time so
the buckets add up to the request (`db`, `cache`, `ext`, `fn` = your code,
`framework`, `compile`, `idle`), plus TTFB, request and response bytes, span
counts, a `cold` flag and the dev-rebuild `epoch`.

**Findings** (`trace.findings`): nine rules with stable fingerprints, so the
same problem groups across requests: N+1 (including a loop over a traced
per-item function), duplicate calls, parallelizable chains of 3+, slow
functions, fetches that opt out of Next's data cache, cold compiles, large
payloads, swallowed errors and warn/error logs on a success. Tune them with
the new `insights` option (`thresholds`, `disable`).

**Read APIs** under `/__hoplens/api`:

- `GET /stats[?buckets=1&since=]`: per-route latency histograms that outlive
  the trace ring (exact quantiles while a sample is small, per URL variant),
  a findings rollup ranked by saveable ms per request × requests, error kinds,
  per-edit p50 deltas, example requests (failed ones excluded) and the count
  of requests in epochs no longer kept.
- `GET /traces?q=&since=`: a small query language (`status:5xx dur:>200
  route:/api/* method:post has:n+1 kind:route cold:true "free text"`, `-`
  negates; free text also searches logs and bodies). The grammar ships as
  the pure `@hoplens/core/query` subpath.
- `GET /queries[?kind=db|cache|fetch]`: normalized query and host shapes
  with calls, p95, errors, routes and callers.
- `DELETE /traces` clears the buffer and broadcasts an SSE `clear`.
- `GET /health` and `/health/stream`: event-loop delay (without the sampler's
  own timer interval), memory, GC, and uncaught exceptions / unhandled
  rejections. `/events` also carries `health` ticks.
- `GET /compare?a=&b=`, `/compare/baselines`, `/compare/pins`: span-level and
  shape-level diff of two traces (`x10 -> x1`), bucket deltas and a JSON diff
  of the bodies. Compared traces are pinned past ring rotation; a manual pin
  (`POST /compare/pins/:id`) is never released by automatic ones.
- `GET /epochs`, `/regressions`, `/epochs/events`: dev rebuilds as edits,
  attributed to the saved files (a source watcher), the routes that import
  them, and a module-level diff of the rebuilt chunks. A save that changes no
  module code is not an edit, and a route the rebuild didn't touch is not
  marked cold. A regression compares the URL variants present on both sides
  of an edit, so a change in traffic mix is not reported as a slowdown, and a
  verdict outlives the baseline it was judged against.
- `POST /run?repeat=N` replays a request up to 50 times in sequence. It stops
  at the first 5xx unless `keepGoing` is set, has a 120 s total limit, and
  reports warm p50/p95 against the previous batch. A body that is not JSON
  gets a 400; only a batch that never reached the app returns 502.

**Persistence** (`persist: true`, off by default): facts and summaries are
appended as NDJSON to `<distDir>/cache/hoplens` (two files of at most 5 MB),
so stats, edits and verdicts survive a dev restart. Bodies, headers, spans,
logs and error messages are never written; titles that quote a log line or
an error are stored without the text, and URL query values are masked unless
short and plain.

`Runtime.stop()` stops every background task (health sampler, watchers,
persistence after a final flush) and the standalone UI server. It is
idempotent and also runs on process exit.
