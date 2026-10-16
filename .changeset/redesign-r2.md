---
"@hoplens/core": minor
"@hoplens/ui": minor
---

Redesign, round 2: palette, keys, lists, a cause-first Overview, health and replay xN.

UI:

- Ctrl/Cmd+K opens a command palette over findings, routes, recent requests, query shapes, edits,
  views and actions. Matching is fuzzy, recents show first, and the server search covers logs and
  bodies. Enter runs a row's main action and Ctrl/Cmd+Enter its secondary one. Findings are ranked
  and worded as on the Overview.
- `?` opens a sheet of the keys that work here. It is generated from the keymap, like the footer
  action bar, so neither one lists a key that does nothing.
- The request log aligns its columns, shows the query string, and drops columns as it narrows.
  Queries is now a list | subject split (`#/q/<shape>`) with SQL / Cache / Fetch segments, sortable
  columns, a loop chip and a "Group by host" toggle that follows the column sort.
- The Overview leads with one sentence: the top repeatable finding by saveable ms per request x
  requests. Findings seen once and dev compiles rank last. It also shows routes by time spent with
  a per-edit p50 delta, and one errors line (5xx / thrown / swallowed) whose filters match its
  counts. A route opens as a subject with fast / typical / slow example requests, chosen from
  requests that succeeded.
- The top bar shows event-loop delay, memory and request rate. A single loop stall stays visible
  for a few seconds. Uncaught exceptions and unhandled rejections open in a panel.

Core:

- `GET /api/stats` adds a findings rollup (mean saving per request, impact, seen once), error kinds,
  per-epoch p50 deltas and per-route exemplars (failed requests excluded).
- `POST /api/run?repeat=N` replays a request up to 50 times in sequence. It stops at a 5xx unless
  `keepGoing` is set, and runs have a 120s total limit. It reports warm p50/p95 against the last
  batch. A request carries its batch id. A body that is not JSON gets a 400, and only a batch that
  never reached the app returns 502.
- `/api/events` carries `health` ticks.
