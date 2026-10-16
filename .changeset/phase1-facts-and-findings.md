---
"@hoplens/core": minor
"@hoplens/ui": minor
"hoplens": patch
---

Phase 1: every finished request now explains itself.

**Facts** (`trace.facts`): where the time went, by interval-union self time so
the buckets add up to the request duration (`db`, `cache`, `ext`, `fn` = your
code, `framework`, `compile`, `idle`), plus TTFB, request/response bytes, span
counts, a `cold` flag and a coarse dev-rebuild `epoch`. Dev compile spans get
their own `compile` hop kind, and Turbopack's untraced on-demand compile gap is
counted as compile time instead of idle. Next's `AppRender.fetch` span and
Hoplens's own fetch span for the same call are folded into one, so counts and
rules see each outgoing call once.

**Findings** (`trace.findings`): nine rules with stable fingerprints so the UI
can group the same problem across requests: N+1 (including a loop over a
traced per-item function), duplicate calls, parallelizable chains of 3+,
slow functions, fetches that opt out of Next's data cache, cold compiles,
large payloads, swallowed errors (reported once per failure) and warn/error
logs on a success. Thresholds and rules are configurable via `insights`.
Analysis runs after the response, off the request path, within the < 2 ms
budget (`pnpm --filter @hoplens/core bench`).

**UI**: a new Overview landing page (KPIs with sparklines, "Needs attention"
grouped findings, per-route table, cold requests excluded from percentiles by
default), a request header with the time budget bar, findings chips that
highlight their spans in the waterfall, and Clear (DELETE
`/__hoplens/api/traces`, broadcast as an SSE `clear` event). The Errors KPI,
the Traffic "Errors" filter and the error badge now share one definition (5xx).

Also: spans that end after the response are kept in the timeline (marked
late) instead of being dropped, and the upstream CDN cache header moved to
`hoplens.fetch.upstreamCache`.
