---
"hoplens": patch
"@hoplens/cli": patch
---

Fix TypeScript's `Cannot find module '@hoplens/next'` error after
`npx hoplens init` on pnpm projects.

0.1.0 / 0.1.1 wrote `import { withHoplens } from "@hoplens/next"` into
`next.config.ts`, which only resolves at runtime (via pnpm's symlink
graph) but not for TypeScript — pnpm's strict isolation never hoists
transitive deps into the top-level `node_modules/<name>/`. Users had
to run `pnpm add -D @hoplens/next` as a second install to satisfy TS.

0.1.2 fixes this by routing both imports through the `hoplens` meta's
subpaths:

- `init` now writes `from "hoplens/next"` and `await import("hoplens/node")`
  (new `./node` subpath on the meta).
- The meta's `tsup.config.ts` bundles `@hoplens/next` + `@hoplens/core`
  code and types into `dist/next.*` and `dist/node.*`, so `hoplens/next`
  is fully self-contained.
- `doctor` and `remove` accept both the modern and legacy forms, so
  re-running on an older install is still idempotent and round-trips
  byte-identical.

`npm i -D hoplens` is now the only install step for a greenfield Next
app, as originally promised.
