---
"@hoplens/core": minor
"@hoplens/ui": minor
"@hoplens/cli": patch
---

Redesign, round 4: opt-in persistence, the phone layout, call-site capture and the integration fixes.

Core:

- `persist: true` keeps facts and summaries (never bodies, headers, spans, logs or error messages) in
  `<distDir>/cache/hoplens`, so stats, edits and regression verdicts survive a dev restart.
  Finding titles that quote a log line or an error message are rebuilt without the text, and query
  values are masked unless short and plain. `Runtime.stop()` stops every background task.
  `hoplens remove` deletes the cache.
- N+1 findings point at the loop's call site (`location.via: "call-site"`). `/api/stats` and
  `/api/traces` take `?since=`. Nameless `fs.watch` events (Windows overflow) trigger a rescan.
- A route a save did not rebuild (per the chunk diff) is no longer marked cold on its next request.
- A regression verdict outlives the baseline it was judged against; restored sessions replay them.
- The parallelizable fingerprint no longer depends on the run length, and 1-2ms of timer overlap
  counts as sequential, so one loop is one finding.
- Event-loop delay no longer includes the sampler's own timer interval (idle reads ~0ms, not 20-32ms).
- An "about the same" compare sentence lists no deltas as causes.

UI:

- Phone layout (<= 760px): bottom tabs, subject pages with Back and swipe, tree-only canvas,
  details in a bottom sheet, no key hints on touch.
- Esc in the source viewer closes only the viewer; Esc from a compare returns to its request.
- The verdict ranks a slow function by its own time, so a cold compile no longer outranks it.
- NEXT marks findings an edit fixed ("not seen since e5") and ranks them after current ones; a revert
  that undid a regression reads "fixed the e5 regression".
- Changes counts this session's edits only and greys restored ones; tick labels never overlap.
- Where to look names the same call site as the verdict; folded loop rows keep their name.
