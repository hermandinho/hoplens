---
"@hoplens/core": minor
"@hoplens/ui": minor
---

Redesign, round 3: compare, replay x10, the Changes timeline and the since-edit scope.

UI:

- Compare (`#/cmp/<a>..<b>`) merges two requests into one diff: a summary sentence, a bucket table
  (ms or share of total), count changes, findings added and resolved, a span tree with an
  only-changes toggle, and response and request diffs. `c` compares with the default baseline
  (previous build, else the previous same-URL request, else the route median). `c c` picks the
  baseline from the list, and Esc returns to the request. `d` diffs against the previous build. `p`
  pins a request so it is kept past ring rotation. Tones use the max(20%, 5ms) noise floor.
- Replay: `r` replays the open request once, and `R` runs it x10 with warm p50/p95, a per-run strip
  and "vs last run". The builder has the same Replay x10. A batch is one row in the request log.
- Changes is a timeline of edits (dev rebuilds) with one dot per request. For each edit it lists
  the files saved, the routes the edit affects and a verdict per route. Verdicts for routes the
  edit doesn't touch are listed separately and muted.
- The since scope (`?since=e<n>`, keys `s`, `e`, `E`) narrows the Overview, the request log and
  Changes to an edit and later, behind an explicit chip. A rebuild toast names a route that got
  slower and goes away if a later verdict clears it.

Core:

- `GET /api/compare`, `/api/compare/baselines` and `/api/compare/pins`. A pin made with `p` is
  never released by Compare's automatic pins.
- Edits are attributed from a module-level diff of the rebuilt chunks. A rebuild that changed no
  module code is not a new edit, and `routesVia: "chunks"` names the routes from the bundler. The
  diff is off in production.
- `GET /api/stats` reports per route the requests in epochs it no longer keeps (`evicted`), so a
  since scope can show when its counts are a lower bound.
