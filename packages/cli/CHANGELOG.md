# @hoplens/cli

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
