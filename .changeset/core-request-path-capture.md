---
"@hoplens/core": minor
"@hoplens/express": minor
"@hoplens/cli": patch
---

Request path, first milestone (P1): which code a request ran, from V8 block coverage. Opt-in with
`HOPLENS_PATH=1` (read at boot only; restart to change it). With the flag unset nothing of it loads
and nothing runs.

- `@hoplens/core/coverage` (new entry): starts V8 precise block coverage (`callCount`, `detailed`) on
  a main-thread inspector session and never stops it. Under `NODE_V8_COVERAGE` (c8) it refuses and
  reports `disabled-c8`, so c8's counts are never reset.
- The Express register hook starts it first, before the function-hop shim and hooks, so every app
  module compiles with block counters. Only that one small file loads early. The banner prints
  `request path: on (block coverage; CPU-heavy code runs slower)`.
- `POST /api/traces/:id/path` replays a GET or HEAD trace once, alone, as a new trace: it waits for
  the app to be idle (no request in flight for 150ms, max 3s, else 409 `not-quiet` and nothing is
  sent), resets the counters, runs the replay, settles 250ms (extended on late spans, max 2s) and
  takes the counts of the project's own scripts. Function-hop counts are cross-checked against
  coverage call counts, and each block against its function's call count (a block counted more
  often outside a loop is an earlier call resuming after an await). Another request in the window
  (starting, or still recording spans), more calls than hops, or such a block makes it retry once,
  then mark the capture CONTAMINATED (kept, every truth unknown, with the reasons). The same excess
  on both tries runs a control window with no replay: counts there mean background work
  (CONTAMINATED), none mean calls through a local binding (PARTIAL, unchecked). A trace past the
  1000 function-hop cap is PARTIAL without the cross-check; lanes are capped at 300. The discarded
  attempt's trace is stamped `pathTrace.supersededBy`, and listed in `window.attempts`. One capture
  at a time (409 `busy`); other methods get 400; the replay has a 30s deadline (502). Every error
  body is `{ code, error, ...details }` with a stable `code` (`method`, `not-found`, `no-path`,
  `superseded`, `evicted`, `path-off`, `busy`, `not-quiet`, `take-failed`, `replay-failed`). The payload (`v: 1`) has one lane per handler/function
  hop with file:line, call counts, function-level truth and the raw block ranges (offsets, counts,
  lines), and a quality of `exact`, `partial` or `contaminated`. `GET /api/traces/:id/path` returns
  the last 20 (410 `evicted` for an older path trace). Trace summaries and the live stream carry
  `pathTrace` (an `update` event follows the stamp). `/api/meta` reports
  `path: { state: off | on | disabled-c8 | error }`; `error` also covers precise coverage stopped by
  another inspector session (detected on take; restart the app). The trace store counts in-flight
  requests (`inflight()`).
- `hoplens doctor` notes when `HOPLENS_PATH=1` is set in the dev script or the environment, and warns
  when `NODE_V8_COVERAGE` is set with it.
