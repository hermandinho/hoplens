---
"@hoplens/ui": minor
---

Request path, Path mode (P3): the Journey pane's chips are now Flame | Tree | Path (Tree | Path on
phones), and `x` toggles Path.

- On a normal trace, Path mode explains how to turn the request path on (`HOPLENS_PATH=1` and a
  restart, with a copyable shell line), why it is disabled (c8 / `NODE_V8_COVERAGE`, coverage error),
  or that it is Express only for now. When it is on, "Trace path" replays the request once, alone, as
  a NEW trace (GET / HEAD only; other methods say why), with a quiet... replaying... settling...
  mapping progress row. Refusals read by error code: the app was busy (the requests in flight, Retry),
  another capture is running, the path is off, the replay failed or hit its 30s limit.
- The new trace opens in Path mode with a `path trace` badge, a `replay of <id>` link and its quality
  (EXACT / PARTIAL / CONTAMINATED, warnings listed). Path traces carry a `path` marker in the request
  list and open in Path mode.
- The verdict line (`Exited: return at GET /api/products/:id L21 via if !(await findProduct(id)) ->
  then`) tops a trail with one lane per function / handler hop in span order, indented by depth, with
  file:line and calls. Chips show each reached decision's side (`if !(await findProduct(id)) -> then`),
  loops (`for (const r of rows) x9600`), splits (`then 3/7 . else 4/7`, outlined), `2 calls: totals`
  for a function that ran more than once, UNKNOWN hatched with its reason on hover and focus, exits
  (`return @L21 exit`, `threw @L19`) and a `+N not reached` expander. Clicking a lane or chip (or
  j / k and Enter) opens the source at that line. Everything shown comes from the server's analysis.
- The palette offers "Trace path" on a trace it can run on.

Request path, function panel (P4): clicking a lane or chip (or Enter on a lane) now opens that
function's panel, beside the trail at 1100px and wider, in its place below (a `Trail > handler >
callee` breadcrumb leads back). `v` toggles Flow / Source, Backspace goes back to the caller, Esc
closes, and focus returns to the lane.

- Flow: an SVG flowchart of the server's per-function graph, laid out top-down (series-parallel, no
  layout library). Statements are boxes, decisions diamonds with arm edges labelled by count, loops
  a back edge with `xN`, try / catch / finally one frame, switch a fan-out by case, return / throw
  terminal pills (the request's exit in bold). Taken edges are solid with counts, not-run code is
  dashed and folded (`> N lines not run`, not-run if arms as stubs beside the diamond), runs of three
  or more plain statements with one count are one box, UNKNOWN is hatched with its reason on hover and
  in the focus caption. An edge out of an arm is solid only when the arm's last node ran too, and a
  switch clause that falls through draws into the next clause, not out of the switch. Calls to
  another function of the path are link chips that open its chart; a call the server found more than
  one traced function for shows without a link. Arrow keys move between nodes, Enter follows a link
  or opens a fold (focus moves to what it opened), `u` unfolds everything and folds it back, and
  Backspace from a followed callee lands on its chip; every node has an aria label (`decision if
  user.vip: then not taken, else taken 1 time`). The chart scrolls sideways inside the panel only and
  opens on its spine.
- Source: the function's lines with a gutter of counts (`x3`, `0` dimmed, `?` hatched with the
  reason), decision lines annotated with the arm taken (`-> else`, `then 1/3 . else 2/3`), loops with
  their passes, exits marked, and not-run regions of two lines or more folded. It is the default on
  phones (where the Flow / Source switch stays shown), above 150 graph nodes, and the only view where
  there is no chart (UNKNOWN functions, charts left out by the payload cap). The count gutter and line
  numbers stay put while a long line scrolls sideways. A file edited since the trace shows `?` on
  every line (UNKNOWN: the file changed) instead of counts that belong to other lines.
- An evidence footer reads e.g. `block coverage . identity map . quiet window . EXACT`. Swipes that
  start in the chart or the source no longer move to the next request on phones. As in the trail,
  every count shown is the server's.

TypeScript (P5): a function mapped through its source map reads `source map` in the evidence footer; the new
reasons say why one was not (`unmapped`: the compiled code does not line up node for node;
`no-generated-text`: register Hoplens after the loader).
