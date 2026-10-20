---
"@hoplens/next": patch
"@hoplens/core": patch
"@hoplens/cli": patch
"@hoplens/express": patch
"hoplens": patch
---

Fixes found while checking a real install and the docs:

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
