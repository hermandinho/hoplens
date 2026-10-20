# @hoplens/transform

## 0.4.0

### Minor Changes

- f93f120: Request path, first milestone (P1): which code a request ran, from V8 block coverage. Opt-in with
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

  Request path, fifth milestone (P5): TypeScript and other compiled setups, exact where the mapping is
  certain.

  - V8's offsets point into the text it ran. For plain JavaScript and Node's own type stripping (Node
    22.18+ by default, or `--experimental-strip-types`: types become spaces) that is the file on disk
    (identity, as before). For a loader's output (tsx: ESM or CommonJS, `tsx watch`) the function's
    analysis now runs on that generated text's own control-flow model (identity on the text V8 ran),
    and is carried over to the file only when its inline source map pairs the two models node for
    node: the same tree (kinds, arms, cases, exits, loops, expression decisions, awaits, nested
    functions) with every executable node's map anchors inside the paired raw node (none of another
    source). The result shows the file's own lines and labels; the function has `mapping:
sourcemap` and `generated: { hash, length, via }`. A compiler that drops, adds or reorders code
    in a function (a dead statement it removed) leaves it UNKNOWN `unmapped` with the reason in the
    payload's warnings; nothing is guessed.
  - The generated text comes from Hoplens' own loaders while the request path is on: the ESM hook in
    COMPILED mode (`tsx --import hoplens/express/register`) posts what V8 will run, and the CommonJS
    layer keeps what a require hook (tsx's) hands `module._compile`; only output with an inline source
    map, bounded (1M chars per file, 16M in all, least recent dropped). Checked against V8 (the module
    function's length) and the map's `sourcesContent` when present (a prefix is fine: Hoplens' trailer).
  - When a source map says the script is compiled but no text was kept (tsx registered after Hoplens,
    so it ran first), every function is UNKNOWN `no-generated-text` with how to fix the order.
    `HOPLENS_PATH_DEBUGGER=1` opts in to reading those scripts with `Debugger.getScriptSource` after
    the capture's final take (about 200ms the first time on the test app; `window.debuggerMs`), through
    one Debugger session kept enabled for the life of the process (disabling it would drop V8's block
    counts). The warning says why no text is at hand: Hoplens' loaders off, a size cap, Node's own
    `--experimental-transform-types`, or the loader order. Retained texts are least recently used out,
    reads included; decoded maps and generated models are cached across captures.
  - New reasons: `unmapped`, `no-generated-text`. `register({ retainGenerated })` in
    `@hoplens/transform`; `@hoplens/express` sets it when the request path is on.

- dda80a9: Transform cache and debug log for `register()`.

  - New `cacheDir` option: both loaders (the ESM hook in the hooks worker, the CommonJS layer on the main
    thread) look each file up in `<cacheDir>/<sha1>.hlc` (not `.json`, which nodemon watches) before they parse it, so a restart with
    unchanged files loads no TypeScript in either thread. The key covers the source bytes (and, for
    COMPILED mode, the raw file on disk), the path relative to the root, the mode (`raw`, `compiled`,
    `cjs`), the preset, the include / exclude globs, the transform build (`dist/index.js`) and the
    TypeScript package it would load. Entries store the same-length `const` -> `let  ` swaps and the
    appended text, checked against the source again on a hit; corrupt, partial or mismatched entries are
    misses; a `none` computed while TypeScript failed to load is not stored. Written atomically, bounded
    to 5000 entries / 50 MB (least recently used dropped first, by an asynchronous scan at most every 10
    minutes per dir), off with `HOPLENS_TRANSFORM_CACHE=0`. Request-path retention is unchanged: it keeps the loader's text.
  - `HOPLENS_DEBUG=transform` (or the new `debug` option) prints one line per in-scope file with export syntax to stderr
    (`hoplens:transform src/a.ts mode=compiled wrapped=2 cache=hit 0.3ms`), with `refused=<reason>`
    and a short label, and `ts=loaded(hooks|main)` on the file that made a thread load TypeScript.
    New exports: `debugLine()`, `transformDebug()`, `REFUSAL_LABELS`, and `typescriptLoaded()` from the
    main entry.
  - With `verbose` (implied by `debug`) reports carry `mode`, `cache`, `ms` and `ts`, and files parsed
    with nothing to wrap are reported as `type: "none"`. Without it reports are unchanged.
  - New `flushReports(cb, timeoutMs?)`: runs `cb` once every report the ESM hook posted so far reached
    `onReport` (the hooks worker answers on the same port, after them), or after the timeout.

- d11e0a8: New `@hoplens/transform/cfg` entry: `buildCfg(ts, text, fileName)` builds a structured
  control-flow model of every function in a file from the TypeScript AST, for the request path's
  per-decision truth. Statements stay grouped in blocks; decisions keep their arms in source order
  (`if` / `else if` chains flattened, `switch` cases with fall-through, `?:`, and `&&` / `||` / `??`
  marked shown when the right side has a side effect or is the value returned); loops of every kind
  with their labels; `try` / `catch` / `finally`; `return`, `throw` and labeled `break` /
  `continue`. Await points are counted on their statements, nested functions and callbacks are
  functions of their own (linked by id, never inlined), and type-only TypeScript is skipped. Every
  node has source offsets (first token) and lines; a function lists the offsets V8 may report as its
  start. Pure (TypeScript is passed in), cached per file text, capped at 2000 nodes per function
  (the rest folds), 300 levels of nesting and 250ms per file; a file whose nesting still overflows
  the stack is `truncated` with no functions.

  Decisions in code their statement may skip are `guarded`: the tail of an optional chain after
  `?.`, destructuring and parameter defaults, a for-of / for-in binding (per pass), a logical
  assignment's right side. `&&=` / `||=` / `??=` are never shown (V8 keeps no counter for their right
  side). A function with parameter defaults or patterns is flagged `paramInit`; functions created in
  parameter defaults and class static blocks are in the model; class field initializers keep their
  functions but not their decisions (V8 runs them elsewhere); `with (o) body` is its body.

- 15df8f3: Groundwork for function hops outside Next.js. The Next.js output is unchanged.

  - New `preset` option: `"next"` (the default, what `@hoplens/next` uses) or `"node"` for unbundled
    servers. `"node"` traces `app/`, `pages/`, `middleware*` and `proxy*` like any other file, and skips
    `*.config.*` at any depth and the root `dist/`, `build/` and `out/` folders. Both presets skip
    `node_modules`, `*.d.ts`, `*.test.*`, `*.spec.*`, `__tests__` and `"use client"` / `"use server"`
    modules.
  - Under `"node"`, `export { f }` and `export { f as g }` wrap `f` once when it is a top-level
    `function f` or a `const` / `let` / `var` bound to a function. Re-exports (`export { f } from`),
    imports, classes, generators and aliases to `default` are left alone.
  - New `collectTargets()` lists the functions a module exports without rewriting it, and
    `mayHaveTargets()` is a regex prescan that rules a file out before TypeScript is loaded.
  - `@hoplens/transform/register` now registers a Node ESM load hook (`module.register()`, main thread
    only, once per process) that rewrites in-scope ES modules (`preset: "node"` by default) when the
    source it gets is byte-identical to the file on disk.
  - CommonJS: `register()` also installs a layer on `Module._extensions` (`.js`, `.cjs`, `.ts`, `.cts`,
    whichever handlers exist) that stays outermost: it re-wraps a handler another loader (tsx,
    ts-node) installs later, on the next `require`. For an in-scope file it hands the next handler the
    source from disk plus the trailer, through an `fs.readFileSync` swap that answers for that one
    resolved filename only, from the handler call until it calls `module._compile` (an own property of
    that one module object; `Module.prototype._compile` is never touched), restored in `finally`.
    The transform runs only when the handler reads the file. A CommonJS module whose source Node's ESM
    loader already read (an `--import` entry, a file imported from ESM) loads untouched and is reported
    as `reason: "esm-loader"`. A handler slot that wraps whatever is assigned to it (append-transform)
    is healed once per handler another loader installs, and a patcher that wraps `fs.readFileSync`
    during a swap keeps the layer's read under its own for good (no read loop). CommonJS that Node's
    ESM loader reads itself (`.cts`, or `.ts` in a CommonJS package, under `--import`) is wrapped in the
    ESM hook when its source is the file on disk. The disposer puts `Module._extensions` and
    `Module._load` back.
  - New `transformCommonJS(source, file, opts)`: TypeScript with `export` syntax gets the module
    trailer (the loader compiles the rebinding); JavaScript with `import` / `export` syntax is left to
    the ESM path; CommonJS shapes (`exports.X = f`, `module.exports.X = f`, `module.exports = { a, b: f,
c() {} }`, `Object.defineProperty(exports, "X", { value })`, tsc's `exports.X = void 0` header) get a
    trailer that rebinds the exports property only when it is still an own writable data property
    holding a function, inside try/catch: getter, frozen and non-writable exports are skipped without
    throwing, and `module.exports = f` is never wrapped. One function under several keys gets one
    wrapper; a function calling itself through its own export (`exports.f(n - 1)`, tsc's
    `(0, exports.f)(...)`, `this.f()` in a method) is skipped; tsc's `(0, exports.f)(...)` is a call, not
    a value use. In a `.ts` / `.cts` file the appended line is preceded by `// @ts-ignore`, so
    ts-node's type-check accepts it. `mayHaveCommonJSTargets()` is its regex prescan.
  - Under `"node"`, an `include` glob that starts with `dist/`, `build/` or `out/` brings that build
    output back into scope (a broad `**` does not).
  - COMPILED mode, for a `.ts` / `.mts` ES module another loader compiled before the hook saw it (tsx
    first: `tsx [watch] --import ...`, `node --import tsx --import ...`): new `transformCompiled(compiled,
raw, file, opts)` parses the raw file from disk for what to wrap and its lines, finds each function
    in the compiled output by its exported name (esbuild's `export { a as b }` clause or an exported
    declaration) as one top-level `function` or `const` / `let` / `var` binding of the same kind and
    async-ness (`__name(...)` keep-names calls allowed), and appends the trailer. Nothing before EOF
    moves (only same-length `const` -> `let  ` swaps), so the loader's inline source map and stack
    line:col stay valid. Any mismatch refuses the whole file (`reason: "unmapped"`, with a `detail`); any
    other changed source is refused as before (`reason: "compiled"`) and loads untouched. Each file is reported to an `onReport`
    callback (wrapped, refused, failed), and the returned disposer turns the hook into a pass-through.
  - Under `preset: "node"`, a file with a syntax error is left alone, so it fails exactly as it would
    without Hoplens.
  - Under `"node"`, a function the module itself uses as a value (`bus.on("x", f)`, `{ f }`,
    `export default f`, `new f()`), one that uses `this`, and one that calls itself are not wrapped, so
    listener identity, `instanceof`/`constructor` checks and recursion depth stay as without Hoplens.
    The ESM hook refuses sources over 1 MB (`reason: "large"`) and matches files against the root's
    real path too (a cwd reached through a symlink or junction).

### Patch Changes

- c520fcb: Fixes found while checking a real install and the docs:

  - Next with pnpm: the Turbopack and webpack rules now get `@hoplens/transform/loader` as an absolute
    path resolved from `@hoplens/next` itself, and the UI is found through `@hoplens/core`. Before, pnpm
    (which does not hoist transitive dependencies) failed with "Could not parse module
    instrumentation.ts, file not found" (Turbopack) or "Cannot find module '@hoplens/transform/loader'"
    (webpack). If the loader can't be found, function hops are skipped and `next dev` keeps running.
  - Next: an edit to the first route a fresh `next dev` served now opens an epoch. The tracker records a
    baseline of the chunks compiled before its first probe; before, Turbopack's in-place rewrite of that
    chunk looked like added modules only and the edit was dropped.
  - Per-request analysis is about a third faster (facts sweep without per-span event objects, bounded
    shape caches instead of a per-span WeakMap); results are unchanged.
  - Restart edits: a `.json` file no module imports never counts as a code edit, wherever it sits;
    `package.json`, `tsconfig*.json` and `jsconfig*.json` still do.
  - doctor: the `.ts` entry check reports an error only for a plain `node` run with no TypeScript loader,
    judged by the Node version the project pins; unknown runners get an info line. The port line says
    the UI uses 4983, or the first free port up to 4993.
  - The request path UI is called "the Path view (press x on a request)" everywhere.
  - The `hoplens` package description mentions Express.
  - Windows: function hops work for a project whose path contains an 8.3 short name (e.g. a temp dir
    under `C:\Users\RUNNER~1`). The hooks resolved the scope root with `fs.realpathSync.native`, which
    expands the short name, while Node's own resolvers keep it, so no file matched and nothing was
    wrapped.

- c520fcb: Function hops work the same on Node 20.9, 22.x and 24.x with tsx. On Node 22.22.3+, 24.11.1+ and
  25.1+, where tsx 4.23 registers in-thread hooks (`module.registerHooks()`), the ESM hook does too.
  Before this, Hoplens' hook always ran inside tsx's there, whatever the flag order. `tsx --import` and
  `--import tsx --import` were RAW instead of COMPILED, so the request path lost tsx's output. On 24 the
  tsx CommonJS rows also failed (`require.cache` undefined). In-thread, a CommonJS file imported from an
  ES module is now wrapped too. `HOPLENS_LOADER_HOOKS=sync|async` overrides the choice. On Node 20.9 /
  20.10, which run `--import tsx` after Hoplens, the tsx-first rows are RAW. `hoplens doctor` says so,
  says which hook API the Node uses, and flags a `.ts` entry under plain `node` on a Node without type
  stripping. The test suites run their child processes on `HOPLENS_TEST_NODE`, and a `runner-matrix` CI
  job covers 20.9.0, 22.x and 24.x on Linux and Windows.
