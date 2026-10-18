# @hoplens/transform

Source-level transform that re-binds every exported function in a module to a traced wrapper **without moving a single line or column** — source maps stay valid.

Ships three entries:

- `@hoplens/transform` — pure functions (`shouldTrace`, `transformSource`, `collectTargets`,
  `mayHaveTargets`). `preset: "next"` (default) keeps the Next.js excludes; `preset: "node"` drops
  them, excludes `*.config.*` at any depth plus root `dist/`, `build/`, `out/`, and also wraps
  `export { f }` / `export { f as g }` clauses that point at a top-level local function.
- `@hoplens/transform/loader` — webpack / Turbopack loader entry. Used by `@hoplens/next`.
- `@hoplens/transform/register` — `register(opts)` registers a Node ESM load hook (`dist/hooks.mjs`,
  main thread only, once per process) for unbundled servers. It rewrites an in-scope ES module only
  when its source is byte-identical to the file on disk; anything else (another loader compiled it
  first, CommonJS, a parse error) loads untouched and is reported through `onReport`. Used by
  `@hoplens/express`.

Internal to [Hoplens](https://github.com/hermandinho/hoplens). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) instead.
