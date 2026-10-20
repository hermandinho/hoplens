# @hoplens/cli

## 0.4.0

### Minor Changes

- dda80a9: `hoplens doctor` for Express has a Function hops section: whether function hops are on and from where
  (default, `HOPLENS_AUTOTRACE`, `HOPLENS_OPTIONS`, in the dev script or the environment) and for which
  files, what the dev script's runner gets (node `--import` / `-r`, tsx before or after Hoplens, ts-node
  CommonJS; ts-node's ESM loader is flagged as untested), the CommonJS-entry-under-`--import` note (moved
  here from Wiring), the transform cache's location and size (or why it is off), and how to skip files
  with `autoTrace.exclude`.
- e46e5b3: `hoplens init`, `doctor` and `remove` support Express projects. The framework is detected from
  package.json (`next` or `express`); a project with both needs `--framework next|express`, which all
  three commands now take.

  - `init` adds `--import hoplens/express/register` to `scripts.dev` (else `start:dev`, else `watch`)
    and changes no other byte of package.json (indentation, key order, CRLF, trailing newline). It
    wires `node [--watch]`, `tsx [watch]` and `nodemon` (as `--exec "node --import ..."`, or inside an
    existing `--exec "node ..."`), keeping env prefixes such as `cross-env NODE_ENV=development` and
    `&&` chains: only the command that starts the app gets the flag. Other runners (`ts-node-dev`,
    `ts-node`, `pm2`, `bun`, `docker`) are left alone with the line to use printed, and with no dev
    script it prints the one to add. `scripts.start` and the entry file are never edited. A second
    run reports "already wired". `--dry-run` shows a `-`/`+` preview; the install hint and next steps
    use the project's package manager and, when it can tell, the app's port.
  - `doctor` checks that `hoplens` is resolvable from the project (not through `NODE_PATH`; with pnpm
    the `hoplens/express/register` form is recommended), that Express is 4 or 5, and that the dev
    script loads the hook. The hook in `scripts.start` or a production-looking script is critical;
    `NODE_OPTIONS` carrying it (scripts or `.env*`) and `NODE_ENV=production` in the dev script warn;
    a `hoplens(app)` call in the entry file is noted. Same output and exit codes as the Next checks.
  - `remove` takes out exactly what `init` added, so the dev script is byte-identical to before, and
    deletes `node_modules/.cache/hoplens`. The dependency stays, as for Next.

- 86a4b76: `hoplens init` on Next.js no longer imports `hoplens/next` at the top of `next.config`, so `next build`
  and `next start` work on an install without dev dependencies (they failed with "Cannot find module
  'hoplens/next'"). init exports a function that returns your config unchanged outside
  `PHASE_DEVELOPMENT_SERVER` and loads `withHoplens` lazily in `next dev`, for `.ts`, `.mts`, `.mjs`,
  `.js` (CommonJS or ESM) and `.cjs`; `.ts` files use `"hoplens/next" as string` (and
  `"hoplens/node" as string` in `instrumentation.ts`) so next build's type check passes once hoplens is
  pruned. Re-running init upgrades a config written by an older init (keeping its specifier and
  options) and is a no-op after that; `remove` gives back the original config byte for byte from
  either form; `doctor` warns on the old form ("next build/start without dev dependencies will fail;
  run npx hoplens init to upgrade") and on a plain-literal `hoplens/node` import in `instrumentation.ts`.
  Behind the gate, `withHoplens(config, { enabled: true })` no longer turns Hoplens on outside `next dev`.
- 0b46ca3: `hoplens init` asks about request path tracing for Next projects too (in a terminal, default no;
  `--path` / `--no-path` without asking) and writes the flag where `@hoplens/next` reads it:
  `.next/cache/hoplens/path.json` (next.config's `distDir`, or withHoplens' `stateDir`, when they are
  plain strings). `hoplens doctor` reports the request path for Next as it does for Express (HOPLENS_PATH
  in `scripts.dev` or the environment wins over the flag; c8 keeps it disabled), and `hoplens remove`
  deletes the flag with `.next/cache/hoplens`.
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

### Patch Changes

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
- Updated dependencies [f93f120]
- Updated dependencies [c520fcb]
- Updated dependencies [dda80a9]
- Updated dependencies [d11e0a8]
- Updated dependencies [15df8f3]
- Updated dependencies [c520fcb]
  - @hoplens/transform@0.4.0

## 0.2.0

### Patch Changes

- 5bf7200: `npm i -D hoplens` is the only install step again: `npx hoplens init` no
  longer leaves TypeScript reporting `Cannot find module '@hoplens/next'` on
  pnpm projects.

  0.1.x wrote `import { withHoplens } from "@hoplens/next"` into
  `next.config.ts`. That resolves at runtime through pnpm's symlinks, but not
  for TypeScript, because pnpm never hoists transitive dependencies, so users
  needed a second `pnpm add -D @hoplens/next`. Both imports now go through the
  meta package's subpaths:

  - `init` writes `from "hoplens/next"` and `await import("hoplens/node")`
    (a new `./node` subpath). The meta bundles the `@hoplens/next` and
    `@hoplens/core` code and types into `dist/next.*` and `dist/node.*`.
  - `doctor` and `remove` accept both the new and the legacy form, so
    re-running them on an older install stays idempotent and byte-identical.
  - `remove` also deletes what Hoplens wrote under the build output:
    `<distDir>/cache/hoplens` (from `persist: true`) and
    `<distDir>/cache/hoplens.json`.

## 0.1.1

### Patch Changes

- baf9393: Fix `npx hoplens init` failing with `ERR_PACKAGE_PATH_NOT_EXPORTED` when
  installed as a transitive dep (the real user flow — `npm i -D hoplens`).

  `@hoplens/cli` only exposed `./package.json` via its `exports` field, so
  the meta's bin shim's `require("@hoplens/cli/dist/cli.js")` was blocked by
  Node's modern resolver. Now `@hoplens/cli` has `main` + `exports["."]`
  pointing at `dist/cli.js`, and the meta shim uses the clean
  `require("@hoplens/cli")` form.

  Also tightens `e2e/scripts/verify-install.mjs` to install `hoplens` as
  the sole direct dep (with the six `@hoplens/*` workspaces redirected to
  local tarballs via npm `overrides`), so this failure mode is caught by
  CI next time.
