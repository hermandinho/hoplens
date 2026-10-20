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
