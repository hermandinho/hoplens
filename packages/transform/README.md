# @hoplens/transform

Source-level transform that re-binds every exported function in a module to a traced wrapper **without moving a single line or column** — source maps stay valid.

## Entries

- `@hoplens/transform` — pure functions:
  - `shouldTrace`, `inScope`, `mayHaveTargets`, `collectTargets`, `transformSource`: the ES module
    rewrite. `preset: "next"` (default) keeps the Next.js excludes; `preset: "node"` drops them,
    excludes `*.config.*` at any depth plus root `dist/`, `build/`, `out/` (an `include` glob that
    starts with the dir opts it back in), and also wraps `export { f }` / `export { f as g }` clauses
    that point at a top-level local function.
  - `transformCommonJS(source, file, opts)` → `{ code, fns } | null`: the CommonJS rewrite
    (`exports.f = ...`, `module.exports = { ... }`, `Object.defineProperty(exports, ...)`, tsc
    output). The trailer rebinds the exports property after the module ran, only while it is an own
    writable data property holding a function; `.ts` / `.cts` trailers get a `// @ts-ignore` line.
    `mayHaveCommonJSTargets` is its prescan.
  - `transformCompiled(compiled, raw, file, opts)` → `wrapped | none | refused`: COMPILED mode, for a
    `.ts` / `.mts` file another loader (tsx) compiled first. The raw file decides what to wrap; each
    target is found in the compiled output by its exported name, and only a trailer is appended, so
    the loader's inline source map stays valid. Anything it cannot map with certainty is `refused`.
  - `loadTypeScript(root)` and `typescriptLoaded()`: the TypeScript 5/6 the transform uses (its own
    copy first; TypeScript 7 has no JS API), and whether this thread has loaded it yet.
- `@hoplens/transform/loader` — webpack / Turbopack loader entry. Used by `@hoplens/next`.
- `@hoplens/transform/register` — `register(opts)` for unbundled servers, once per process, from the
  main thread only (a `-r` preload that runs again in Node's hooks worker registers nothing there).
  Used by `@hoplens/express`. It installs two layers:
  - **ESM step.** On Node 22.22.3+, 24.11.1+, 25.1+ and later majors it runs in-thread through
    `module.registerHooks()`; below that, in Node's hooks worker through `module.register()`
    (`dist/hooks.mjs`, exported as `@hoplens/transform/hooks`). That is the same split tsx makes, so
    the flag order decides which loader sees the other's output. `HOPLENS_LOADER_HOOKS=sync|async`
    overrides; `hookApi()`, `registeredHookApi()` and `importOrderHonored()` (false on Node 20.9 /
    20.10, which run `--import` modules out of order) report the choice. A source byte-identical to
    the file on disk is rewritten (RAW); a `.ts` / `.mts` another loader compiled first goes through
    COMPILED mode; any other changed source is refused, never rewritten.
  - **CommonJS layer.** A self-healing wrapper on `Module._extensions` that stays outermost over tsx
    and ts-node, and hands the inner handler the transformed source through `fs.readFileSync`, for
    that one file only and only until it compiles.

  A file that loads untouched is reported with a reason: `compiled`, `unmapped`, `commonjs`,
  `esm-loader` or `large` (`REFUSAL_LABELS` has a phrase for each).
- `@hoplens/transform/ts` — `loadTypeScript(root)` on its own, for callers that need no transform.
- `@hoplens/transform/cfg` — `buildCfg(ts, text, fileName, opts?)`: the control-flow model of every
  function in a file (blocks, `if` / `switch` / loop / `try` arms, exits, folds), capped at
  `MAX_NODES` nodes and `MAX_FILE_MS` per file, cached by file name and text. The request path's
  flowchart and decisions are built from it. `walkCfg` visits a function's nodes.

## `register()` options

`RegisterOptions` extends `TransformOptions` (`root`, `include`, `exclude`, `preset`; register
defaults `preset` to `"node"`):

| Option | Effect |
|---|---|
| `onReport(report)` | Called on the main thread for each wrapped, refused, failed (and with `verbose`, nothing-to-wrap) file. Each report carries `mode` (`raw`, `compiled`, `cjs`), `cache` (`hit` / `miss`), `ms`, and `ts` when that file made a thread load TypeScript. |
| `cacheDir` | Transform cache directory (`<stateDir>/transform` for Express). Each transform is looked up first by a hash of its input, so a warm restart loads no TypeScript. Unset, or `HOPLENS_TRANSFORM_CACHE=0`: no cache. |
| `debug` | Print one line per in-scope file to stderr (`debugLine()`). Default: `transformDebug()`, true when `HOPLENS_DEBUG` names `transform`, or is `1`, `*`, `all` or `true`. |
| `verbose` | Also report files with nothing to wrap, without printing. Implied by `debug`. |
| `retainGenerated` | Keep the output another loader compiled an in-scope module to, when it has an inline source map, for the request path. Set only while the request path is on. |

`flushReports(cb, timeoutMs = 500)` calls `cb` once every report the ESM step posted so far has
reached `onReport` (right away for the in-thread hook or when none was registered). `register()`
returns a function that disables both layers.

Internal to [Hoplens](https://github.com/hermandinho/hoplens). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) instead.
