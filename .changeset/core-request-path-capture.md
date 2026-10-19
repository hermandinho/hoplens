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

Request path, second milestone (P2): which arm of every decision the request took.

- The path payload is `v: 2`. Each function carries `analysis`: its decisions (`if` / `else if` /
  `else`, `switch` cases, `?:`, `&&` / `||` / `??` where the right side has a side effect or is
  the value returned, `try` / `catch`), each arm `taken`, `not-taken` or `unknown` with a reason;
  its loops (entries, passes); its exits (return, throw, falling off the end, an exception from a
  callee) with the decision arm each sits in; and the annotated node tree for the flowchart. The
  payload's `analysis.text` is the request's verdict line (`Exited: return at GET
  /api/products/:id L21 via if !(await findProduct(id)) -> then`). Built once, lazily, on the
  POST that captured it or the first GET, and cached with the payload (a few ms per route on the
  example app once TypeScript is loaded).
- Counts are structural, not V8's innermost range: code after an always-exiting arm (an early
  return) is never shown as reached, however V8 clipped its ranges. Arms that sum past their
  decision are `arms-inconsistent`. A split inside one call reads `split-loop` (`then 1/3 . else
  2/3`), across calls `split-calls`; a function called more than once is `blended`, counts are
  totals.
- The throw cut: code after an exception the counters cannot place (a callee that threw
  synchronously, an exception a `finally` replaced) is `after-throw`; the hops' error stacks
  (recorded per function at capture as `errors`) narrow it to the statement that threw when they
  account for every exception there. Awaited rejections stay exact.
- Join validation: the file must hash as it did at capture and not have been modified after the
  app started (`stale`), else `source-moved`; and the function's AST start and end must be its
  coverage range, else `compiled` for a TypeScript file, `no-function` otherwise (`too-large` when
  a cap left the file without functions).
- Exits are completions: a `return` / `throw` that left the function (a throw its own catch took is
  none), unknown when an exception may have been raised inside it or in a `finally` it passed.
  When the counted exits add up to the calls, the unknown ones are 0 (an uncaught callee throw
  reads `Threw: exception in <handler> L<n>`, the line of the escaping error; `(line unknown)` when
  no recorded stack settles it). A deficit the hops did not record as an error (an await still
  pending, a generator parked at a yield) is `suspended`, not an exception.
- Code a statement may skip (optional-chain arguments, destructuring defaults) is never read as an
  exception; a logical there has its short-circuit arm `no-counter`. A function whose parameters
  can run code, or a generator, does not count its first statement from the call count.
- The flowchart graph carries each switch clause's matched count (`sharedArm` for grouped empty
  clauses) and a structural `fallsThrough` (never on the last clause); loop passes read as in
  `loops`; `fns` (functions created at a node, with `fnKey` when the payload has one) and
  `callees` (a call linked to a function the trace recorded as a hop under this one, when the name
  picks exactly one).
- `RuntimeConfig.path.analyzer` supplies the control-flow model; `@hoplens/express` passes
  `@hoplens/transform/cfg` and loads TypeScript once after boot when `HOPLENS_PATH=1`. Without an
  analyzer every decision is `no-analyzer`.
