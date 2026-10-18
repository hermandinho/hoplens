---
"@hoplens/transform": minor
---

Groundwork for function hops outside Next.js. The Next.js output is unchanged.

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
  source it gets is byte-identical to the file on disk. CommonJS is not handled yet.
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
