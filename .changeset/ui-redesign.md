---
"hoplens": minor
"@hoplens/ui": minor
---

A redesigned UI that leads with the cause: one list and one subject per view,
a sentence before the chart, and the keyboard everywhere.

**Shell.** Four views, Overview, Requests, Queries and Changes, each a list
beside the subject you picked, with a draggable splitter that is remembered.
The URL hash holds the state (`#/r/<id>[/s/<span>]`, `#/route/<key>`,
`#/q/<shape>`, `#/changes/e<n>`, `#/cmp/<a>..<b>`, `?since=e<n>`), so every
screen has a link and Back / Forward work; old `#trace=` links still open. The
top bar shows event-loop delay, memory and request rate, keeps a single loop
stall visible for a few seconds, and opens uncaught exceptions and unhandled
rejections in a panel.

**A request** opens with one verdict: what made it slow or fail, about how
much fixing it would save, and where. N+1 loops point at the call inside the
loop, an error caught inside a 2xx reads "Failed silently", a cold request
names its pre-handler wait. A "Where to look" list, the time budget bar and
baselines (same URL, the route, the same URL before the last edit) follow.
The journey is a Tree / Flame canvas with a minimap, the critical path, idle
gaps, log ticks, late spans and repeated calls folded into `xN` rows; a cold
trace opens zoomed to the handler. Details have Response, Request, Console and
Span tabs, with a JSON tree for bodies, args and results, the source inline,
and the logs written during a failing step. The copy menu gives curl,
`fetch()`, a Vitest test (status, query budget, p95-based time budget) or the
trace link. Status badges follow the HTTP status; an error handled inside a
2xx gets its own amber badge.

**Requests** is a windowed log with aligned columns that drop as it narrows,
a query bar with autocomplete, finding badges that prefill a query and
duration bars scaled to p95. Live rows never move the row under your pointer
(an "N new" pill appears instead), and a replay batch is one row.

**Overview** leads with the top repeatable finding, ranked by saveable ms
per request × requests; findings seen once, dev compiles and findings an edit
fixed ("not seen since e5") rank last. Below: routes by time spent with a
per-edit p50 delta, and one errors line (5xx / thrown / swallowed) whose
filters match its counts. A route opens with fast / typical / slow example
requests. Cold requests are excluded from percentiles unless "Include cold"
is on.

**Queries** lists every db, cache and fetch shape across requests (SQL /
Cache / Fetch), sortable, with a loop chip and a "Group by host" toggle that
follows the column sort.

**Compare** merges two requests into one diff: a summary sentence, a bucket
table, count changes, findings added and resolved, a span tree with an
only-changes toggle, and response and request diffs. Changes under
max(20%, 5ms) count as noise. **Replay** runs a request once or ×10 with warm
p50/p95, a per-run strip and "vs last run", from the request or the builder.

**Changes** is a timeline of your edits (dev rebuilds) with one dot per
request: the files saved, the routes the edit affects and a verdict per
route. Routes the edit doesn't touch are listed apart, muted; a revert that
undid a regression says so; edits restored from an earlier session are
greyed. A rebuild toast names a route that got slower and goes away if a
later verdict clears it. The since scope (`?since=e<n>`) narrows the
Overview, the log and Changes to an edit and later, behind a chip, and says
when its counts are a lower bound.

**Keys.** `Ctrl/Cmd+K` opens a palette over findings, routes, recent
requests, query shapes, edits, views and actions. `?` lists the keys that
work where you are, generated from the same keymap as the footer hints:
`1`-`4` views, `/` filter, `j`/`k` move, `Enter`/`Space` open/peek, `[`/`]`
newer/older, `f` highlight the cause, `o` open the source, `t` tree/flame,
`z`/`0` zoom, `c` compare (`c c` picks the baseline), `d` vs the previous
build, `p` pin, `r`/`R` replay once/×10, `y` copy, `b` builder, `s`/`e`/`E`
since scope, `Ctrl+\` collapse the list, `Esc` back.

**Phones** (≤ 760px): bottom tabs, subject pages with Back and swipe, a
tree-only canvas, details in a bottom sheet, and no key hints on touch.

Colour and type come from one token set with separate hue families for time
buckets, severity, accent and diffs, checked for contrast in CI.
