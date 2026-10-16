# @hoplens/cli

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
