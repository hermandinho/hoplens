---
"@hoplens/core": minor
"@hoplens/ui": minor
---

Redesign, round 1: cause first, one list and one subject.

UI:

- New shell: the sidebar, the traffic list and the always-on inspector column are gone. Every view
  is a list | subject split with a draggable, remembered splitter, and every view deep-links through
  a hash router (`#/r/<id>[/s/<span>]`, `#/route/<key>`, `#/queries`, `#/changes/e<n>`,
  `?since=e<n>`). Back and Forward work, and legacy `#trace=` links still open.
- A scoped keymap drives the keys: `j`/`k` move through the list (the open request follows), `[`/`]`
  step to the newer/older request, `/` filters (or searches spans inside the canvas), and on a trace
  `f` highlights the verdict's cause, `o` opens the culprit, `t` toggles tree/flame, `z`/`0` zoom.
- Each request opens with one verdict sentence: what made it slow or fail, how much fixing it would
  save, and where. N+1 loops point at the call inside the loop, swallowed errors read "Failed
  silently", and a cold request names the pre-handler wait. A grouped "Where to look" list and a
  quieter time bar follow. Baselines compare against the same URL variant, the whole route, and the
  same URL before the last edit.
- The canvas gains a minimap (brush to zoom, double-click to reset), highlight that dims instead of
  hiding, folded rows striped by what they spend time on, and a cold trace opens zoomed to the handler.
- One token set for colour and type: separate hue families for time buckets, severity, accent and
  diffs, checked for contrast by `pnpm --filter @hoplens/ui test`.

Core:

- `GET /api/health` and an SSE stream: event-loop delay, memory, GC and recorded process errors.
- `GET /api/compare?a=&b=`: span-level and shape-level diff of two traces (`x10 -> x1`), bucket
  deltas, a JSON diff of the bodies, and trace pinning so compared traces survive the ring buffer.
- Dev-rebuild epochs with source attribution (a watcher on `src/` plus an import graph), and
  `GET /api/epochs` / `GET /api/regressions` with an SSE feed. A regression compares the URL variants
  present on both sides, so a change in traffic mix is not reported as a slowdown.
- Per-route stats keep a per-URL-variant p50, and quantiles are exact while a sample is small.
