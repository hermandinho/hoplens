---
"hoplens": patch
"@hoplens/cli": patch
---

`npm i -D hoplens` is the only install step again: `npx hoplens init` no
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
