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
