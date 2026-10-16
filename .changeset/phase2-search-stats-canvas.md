---
"@hoplens/core": minor
"@hoplens/ui": minor
"hoplens": patch
---

Phase 2: search, server-side stats and a new journey canvas.

**Core**: new read APIs under `/__hoplens/api`: `stats[?buckets=1]`
(per-route latency histograms that survive the trace ring buffer),
`traces?q=` (a small query language: `status:5xx dur:>200 route:/api/*
method:post has:n+1 kind:route cold:true "free text"`, `-` negates; free text
also searches logs and bodies) and `queries[?kind=db|cache|fetch]`
(normalized query/host shapes with calls, p95, errors, routes and callers).
The query grammar ships as the pure `@hoplens/core/query` subpath
(`parseQuery`, `matchQuery`, `compileGlob`); route globs match in linear time.
Redis clients are instrumented as `cache` spans. Dev responses carry a
`Server-Timing` header and `x-hoplens-trace` (opt out with `serverTiming:
false`). Spans that end after the response now emit a throttled SSE `update`
so open views refresh.

**UI**: a dense, windowed request log with a query bar (autocomplete, j/k
cursor, finding badges that prefill a query, p95-scaled duration bars) shared
by the sidebar Traffic tab and a new Requests view; a Queries view; Overview
numbers from the server's stats when available. The journey is now a Tree /
Flame canvas with a critical-path overlay, idle gaps, log ticks and late
spans. The copy menu adds "Copy as Vitest test" (replays the request and
asserts its status, query budget and a p95-based time budget) and "Copy trace
link". Status badges are coloured by HTTP status alone: a 200 is green, an
error caught inside a 2xx shows as a separate amber "handled" badge.
