---
"hoplens": minor
"@hoplens/core": minor
"@hoplens/ui": minor
---

Deepen the trace: every span now carries a source location where possible,
and the UI renders an inline code snippet (±3 lines, highlighted hit) under
each row — click a step and read the actual code without leaving the
waterfall. JSON payloads everywhere (request body, response body, span
args/result) now render through a collapsible tree view with syntax
highlighting instead of a raw string blob.

New instrumentation:

- `globalThis.fetch` is wrapped per-request to emit `fetch` spans with
  cache attribution — the request-side `cache` / `next.revalidate` /
  `next.tags` and the response-side signals edge CDNs set
  (`x-vercel-cache`, `cf-cache-status`, `age`, `cache-control`). This
  works whether or not Next's own OTel is loaded.
- `pg` (node-postgres) is patched automatically when installed in your
  app: every query becomes a `db` span with the SQL, redacted bound
  params, and row count. Prisma users already get spans via
  `@prisma/instrumentation`; their bound params now go through the
  Hoplens redactor before display.
- New `drizzleLogger()` export from `@hoplens/core/trace` for Drizzle
  users who prefer the logger surface; the underlying driver (`pg`,
  etc.) is still the recommended path for real timings.

New in Journey:

- When a step errors, console lines emitted inside its time window show
  up grouped beneath it, so you don't have to hop to the Console tab to
  piece together what went wrong.
