# @hoplens/ui

## 0.4.0

### Minor Changes

- 94bdfa5: Request path: a sticky one-click switch. The path stays off by default; turning it on no longer needs
  `HOPLENS_PATH=1` in every shell.

  - `@hoplens/express`: the register hook reads `<stateDir>/path.json`
    (`{"enabled":true,"since":ISO,"by":"ui"|"init"}`; `node_modules/.cache/hoplens` by default,
    honouring `HOPLENS_OPTIONS` `stateDir` / `root`) before coverage would start. `HOPLENS_PATH=1` / `0`
    always wins, then the flag, else off; the dev gate is unchanged. With the path off the hook only
    reads that one small file. The banner says `request path: on (flag; disable in the Path view, press x on a request)` or
    `request path: on (HOPLENS_PATH)`.
  - `@hoplens/core`: `RuntimeConfig.path.control` (`PathControl`) is an adapter's switch.
    `POST /api/path/enable` and `/api/path/disable` write / remove the flag atomically and answer the
    new `meta.path`. Loopback callers only (even with `allowRemote`), and a non-local `Origin` gets
    403; 409 `env` when `HOPLENS_PATH` decided, 409 `unsupported` without a control (Next.js: Express
    only), 500 `write-failed`. `meta.path` gains `source` (`env` | `flag` | `default`) and `pending`
    (`on` | `off`) until the restart applies a toggle.
  - `@hoplens/ui`: the Path view's off state has an **Enable request path** button (block coverage from
    start; CPU-heavy code runs slower), then "Restart your dev server to apply (saving a file restarts
    node --watch)" with an `on at next start` badge and Undo. On via the flag, the pane's footer has a
    Disable link (`off at next start` and Keep it on after). Set by `HOPLENS_PATH`, it says so and
    offers no toggle. The copyable env command stays as the secondary option.
  - `@hoplens/cli`: `hoplens init` (Express) asks "Enable request path tracing? (block coverage;
    slower for CPU-heavy code) [y/N]" in a terminal (default no; never asked without a TTY),
    `--path` / `--no-path` answer it, and `--dry-run` prints the flag instead of writing it. `remove`
    deletes the flag (with the state dir). `doctor` reports `request path: on (flag)`,
    `on (HOPLENS_PATH)` or `off`, and warns when it would be on with `NODE_V8_COVERAGE` set or when
    the flag file is invalid.

- fe8560e: Framework-neutral copy, and request builder fixes for Express:

  - The top bar shows the host framework from `/api/meta` (`Express 5.3.0`), falling back to the
    older `next` field. Outside Next.js the UI no longer talks about `next dev`, dev compiles,
    `instrumentation.ts`, `withHoplens` or Next's data cache: the framework band, time-budget hints,
    verdict, cold tags and the `cold-compile` label ("cold start") say "first request after
    start/restart" instead. Next.js copy is unchanged.
  - A live-stream reconnect re-reads meta and routes as well as the traces. Outside Next.js a restart
    (node --watch) that dropped old requests is an "App restarted" info note, not an error.
  - Request builder: path params start empty (the chip shows the name), never seeded with their own
    name; Send waits for required params. A param inside a segment (`/report.:format*`) gets its own
    chip, and an empty optional one drops the `.` before it. The route picker shows the template
    traces use (Next keeps its `:param` path), appends the file when one method + template is
    registered in two files, and lists regex routes last, disabled with a reason; a regex route
    opened from a trace can't be sent either. An empty `*` param that fills a whole segment drops its
    `/` too.
  - The vitest export, query suggestions and Changes copy name the framework's own dev loop.
  - A reconnect resync keeps requests that arrived live while it was fetching instead of counting them
    as lost.
  - The builder drawer no longer doubles its chrome: there is one "New request" header and one close,
    and it stays in view. With only the builder open the drawer's head is pinned and carries it; over a
    request or a compare the pinned bar's close closes the builder first, as Esc does.
  - Edits found across restarts (`via: "restart"`) count as edits of the dev loop in Changes even
    though each comes from a new process, are not greyed as earlier-session edits, and read "saved, app
    restarted". Outside Next.js the empty Changes view says "Save a file: node --watch restarts the app
    and the edit shows up here", and the epoch wording follows: a new epoch when a restart changed code.

- 0b46ca3: The Path view works for Next apps: no more "Express only for now"; the Enable / Disable switch shows
  for Next too, and its notes say "Restart next dev to apply" (a save hot-reloads there, it does not
  restart). UNKNOWN `stale-chunk` explains that the bundler rewrote the file's chunk after it loaded
  (restart next dev, or set HOPLENS_PATH_DEBUGGER=1).
- 8eb6d4c: Request path, the Path view (P3): the Journey pane's chips are now Flame | Tree | Path (Tree | Path on
  phones), and `x` toggles Path.

  - On a normal trace, the Path view explains how to turn the request path on (`HOPLENS_PATH=1` and a
    restart, with a copyable shell line), why it is disabled (c8 / `NODE_V8_COVERAGE`, coverage error),
    or that it is Express only for now. When it is on, "Trace path" replays the request once, alone, as
    a NEW trace (GET / HEAD only; other methods say why), with a quiet... replaying... settling...
    mapping progress row. Refusals read by error code: the app was busy (the requests in flight, Retry),
    another capture is running, the path is off, the replay failed or hit its 30s limit.
  - The new trace opens in the Path view with a `path trace` badge, a `replay of <id>` link and its quality
    (EXACT / PARTIAL / CONTAMINATED, warnings listed). Path traces carry a `path` marker in the request
    list and open in the Path view.
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

### Patch Changes

- 46a3673: Security: one guard now fronts every `/__hoplens` route (the UI page, the API, the SSE streams), not just the request path switch. The `Host` and any `x-forwarded-host` must name this machine (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`, any port), which stops DNS rebinding; a browser's `Origin` must be local too (any port, so the Vite dev proxy and the app-port mount keep working). Refusals are 403 `{ code: "forbidden" }` and say where to open Hoplens. `POST` and `DELETE` from a browser must send `content-type: application/json`, and text/plain, form and multipart bodies are refused (415 `{ code: "content-type" }`): a cross-site page can no longer replay requests through `POST /api/run` with a simple request. Scripts that post JSON without the header need to add it. `allowRemote: true` keeps serving any client and Host (rebinding protection is off there; the Origin and content-type checks stay), and the request path switch still answers this machine only. The UI sends the JSON content type on its writes.
- c3e3d79: A response body over the 512KB capture limit keeps its first 512KB even when it is written in one
  chunk (`res.json()` of a large export, `NextResponse.json` of a big list). Before, a single chunk past
  the limit was dropped whole, so the Response tab said "truncated" over an empty body. The label now
  says how much is shown ("truncated: first 20KB of 2.0MB shown").
- b748270: The request builder opens the route entry that declares the request's method when several entries
  share one template (an Express route registered in two files, or GET and POST on separate lines),
  falling back to one that accepts any method. A `route:/` filter now matches only `/` instead of every
  route.

## 0.3.1

### Patch Changes

- 35d2b68: Changes explains itself before your first edit: the "save a source file and send a request" hint now shows
  whenever this session has no edits yet, instead of only when the list was empty, which the always-present
  `e0 session start` row meant it never was.
- 11e1b1f: Changes says what its rows mean and what to do with them: a one-line guide above the timeline, hover text
  on the verdict glyph, p50 and % change, "low confidence" now suggests "replay ×10 to confirm", and
  "compare pair" is "compare before / after". A disabled action button now looks disabled; before, one
  that couldn't run looked clickable and silently did nothing.

## 0.3.0

### Patch Changes

- aa38442: postgres.js (`postgres`) queries show up in the journey with no setup, Drizzle's
  `drizzle-orm/postgres-js` included. Each query is a `postgres.query` db span
  with its real duration, the SQL as sent, redacted bound params, the row count
  and the call site of a tagged-template query. The driver's own queries
  (array-type fetch, session state) are left out, and so are cursors and
  `COPY` streams.

  Under Next, `withHoplens` adds `postgres` to `serverExternalPackages` in dev
  when the app can resolve it, because a bundled copy can't be instrumented. It
  skips this when `postgres` is in `transpilePackages`.

## 0.2.0

### Minor Changes

- 5bf7200: A redesigned UI that leads with the cause: one list and one subject per view,
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
