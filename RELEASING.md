# Releasing Hoplens

Hoplens publishes eight packages: the unscoped `hoplens` meta package and seven `@hoplens/*`
packages (`cli`, `core`, `express`, `next`, `schema`, `transform`, `ui`). Versions are driven by
[Changesets](https://github.com/changesets/changesets) and published by
[`.github/workflows/release.yml`](./.github/workflows/release.yml) on push to `main`.

The packages are **linked**, not fixed (`.changeset/config.json`: `"linked": [["@hoplens/*", "hoplens"]]`).
A package only gets a new version when a changeset names it (or a dependency of it was bumped);
the packages bumped in the same release share the highest version among them. So versions can
differ between packages. After the 0.4.0 release (2026-10-20) every package changed, so all eight
are at the same version for now:

| package              | version | last tag on the repo |
|----------------------|--------:|---------------------:|
| `hoplens`            |   0.4.0 |                0.4.0 |
| `@hoplens/core`      |   0.4.0 |                0.4.0 |
| `@hoplens/next`      |   0.4.0 |                0.4.0 |
| `@hoplens/express`   |   0.4.0 |                0.4.0 |
| `@hoplens/ui`        |   0.4.0 |                0.4.0 |
| `@hoplens/cli`       |   0.4.0 |                0.4.0 |
| `@hoplens/schema`    |   0.4.0 |                0.4.0 |
| `@hoplens/transform` |   0.4.0 |                0.4.0 |

The Version Packages PR is opened by the release workflow with `GITHUB_TOKEN`, so GitHub does not
run the `ci` workflow on it. Its code already passed CI on `main`; before merging it, run
`pnpm lint` on the release branch (the version step's formatting is what broke lint before).

## Preflight: one-time setup

These steps are manual and only need to happen once (or when a token expires).

- [ ] **`@hoplens` npm org exists** and you have write access. Scope-level
      claim blocks squatting on `@hoplens/*`.
- [ ] **Unscoped `hoplens` name** is claimed.
- [ ] **2FA on your npm account**. Required for publish; a GAT bypasses the
      interactive prompt in CI.
- [ ] **`NPM_TOKEN` GitHub secret** holds a Granular Access Token scoped to
      the `@hoplens` org and the `hoplens` package, with Read-and-Write
      (publish and stage) permission. 90-day expiry is a sane default. A token
      limited to a list of existing packages cannot publish a new one, so the
      first `@hoplens/express` release needs the org-wide scope.
- [ ] **`hoplens.dev`** registered (optional: the READMEs link to the GitHub repo).

## What CI runs

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml), on every push and pull request to
`develop` and `main`:

- **`check`** (Linux and Windows, Node 20 and 22): `pnpm lint`, build `packages/*`, typecheck,
  `pnpm -r test`, then on Linux only the overhead benches (`@hoplens/core` and `@hoplens/next`
  `bench`).
- **`runner-matrix`** (Linux and Windows, Node 20.9.0, the latest 22.x and the latest 24.x): function
  hops and the request path across the runner setups (`node --import`, `-r`, tsx, ts-node; the table
  in [`packages/express/README.md`](./packages/express/README.md)). vitest, pnpm and the build run
  on Node 22; the app processes the tests spawn run on the matrix Node, passed as
  `HOPLENS_TEST_NODE`. It runs `test:runners` in `@hoplens/transform` and `@hoplens/express`. Rows a
  Node cannot run (type stripping on 20.9) skip with the reason in the test title. Locally:
  ```bash
  HOPLENS_TEST_NODE=/path/to/node-v20.9.0/node pnpm --filter @hoplens/transform run test:runners
  HOPLENS_TEST_NODE=/path/to/node-v20.9.0/node pnpm --filter @hoplens/express run test:runners
  ```
- **`integration`** (after `check`, Linux, Node 22): `verify:build` (nothing of Hoplens in a
  production Next build) and `verify:install` (pack, install into a scratch Next 16 project,
  `hoplens init`, `hoplens doctor`).

## Normal release flow

1. **Make a change** on a feature branch, land it on `develop` via PR.
2. **Add a changeset**:
   ```bash
   pnpm changeset
   ```
   Pick the affected packages and the bump type (`patch` / `minor` / `major`).
   Describe what changed in one or two lines; this becomes the CHANGELOG
   entry. Commit the generated `.changeset/*.md` with your change. A changeset
   whose text no longer matches the code (a later change on `develop`
   superseded it) should be edited before the release, not left for the
   CHANGELOG.
3. **Merge develop -> main** when ready to release.
4. **The `release` workflow fires.** It installs, builds every package,
   typechecks, runs `pnpm -r test`, `verify:build` and `verify:install` again
   (the last chance to catch a regression before publishing), then runs
   `changesets/action`.
5. **With pending changesets**, the action opens or updates a
   **"chore(release): version packages"** PR. Its commit is made by
   `pnpm run version`, which is `changeset version && biome format --write .`:
   Changesets bumps the `package.json` versions (and, with
   `updateInternalDependencies: "patch"`, the packages that depend on a bumped
   one) and regenerates each package's `CHANGELOG.md`; Biome then formats the
   files it rewrote, so the Version PR passes `pnpm lint` in CI.
   To preview it locally, run `pnpm run version` on a scratch branch and
   look at the diff (do not commit it to `develop`).
6. **Review the Version PR.** If the bumps and changelogs read correctly,
   merge it.
7. **The workflow fires again**, sees no pending changesets and runs
   `pnpm release` (`pnpm -r --filter "./packages/*" run build && changeset publish`):
   every package whose version is not on the registry yet is published with
   sigstore provenance, and the action pushes a `<name>@<version>` git tag for
   each.

## Before a release

1. **Rehearse the pack**: confirm every tarball has the right files (needs a
   fresh `pnpm build`):
   ```bash
   for p in meta cli next express core schema transform ui; do
     (cd packages/$p && npm pack --dry-run)
   done
   ```
   Sizes at the 0.4.0 release (2026-10-20), for comparison. A large jump in one
   package usually means a build started shipping something it should not:

   | package              | version | tarball | unpacked | files |
   |----------------------|--------:|--------:|---------:|------:|
   | `hoplens`            |   0.4.0 |  6.6 kB |  22.2 kB |    41 |
   | `@hoplens/cli`       |   0.4.0 | 79.8 kB | 297.1 kB |     4 |
   | `@hoplens/next`      |   0.4.0 | 44.1 kB | 191.9 kB |    16 |
   | `@hoplens/express`   |   0.4.0 | 169.5 kB | 612.6 kB |   10 |
   | `@hoplens/core`      |   0.4.0 | 912.2 kB | 3347.1 kB |  26 |
   | `@hoplens/schema`    |   0.4.0 | 62.7 kB | 269.2 kB |     8 |
   | `@hoplens/transform` |   0.4.0 | 131.6 kB | 500.8 kB |   18 |
   | `@hoplens/ui`        |   0.4.0 | 151.2 kB | 492.6 kB |     3 |

2. **Run the install-flow smoke** locally:
   ```bash
   pnpm --filter hoplens-e2e verify:install
   ```
   It packs every workspace package the `hoplens` meta package depends on
   (followed from its `workspace:` dependencies), installs them into a scratch
   Next app from the tarballs, then runs `init` and `doctor`.
3. **Verify the dev-only guarantee**:
   ```bash
   pnpm --filter hoplens-e2e verify:build
   ```
4. **After the publish, smoke-test the live install** from the registry:
   ```bash
   mkdir /tmp/hop-live && cd /tmp/hop-live
   npm init -y && npm i -D next hoplens
   npx hoplens --version   # the published @hoplens/cli version
   npx hoplens doctor
   ```
   For Express, the same with `npm i express && npm i -D hoplens`, then
   `npx hoplens init` and `npx hoplens doctor`.

## Troubleshooting

- **`402 Payment Required`**: the `@hoplens` org isn't paid-plan and you're
  trying to publish a private package. Confirm each `@hoplens/*` package.json
  has no `"private": true`.
- **`403 Forbidden`**: `NPM_TOKEN` lacks write access to the package in
  question (or, for a package's first publish, to the org). Regenerate the GAT
  with both `@hoplens` scope and `hoplens` package name selected.
- **`EPUBLISHCONFLICT`**: the version is already on the registry. Bump it with
  a changeset.
- **"The expected sha of the GitHub Actions workflow does not match"**:
  the Version PR was force-pushed. Close and let changesets reopen it on the
  next workflow run.
- **Lint fails on the Version PR**: the `version` script's `biome format`
  step did not run (the action was given another `version:` command). It must
  stay `pnpm run version`.
- **Provenance attestation missing**: confirm the workflow's `id-token: write`
  permission is set and `NPM_CONFIG_PROVENANCE=true` is in the publish env.

## Rolling back

npm's `npm unpublish` is only allowed within 72 hours of publish, so prefer
`npm deprecate` to warn users off a bad version and publish a patch over the
top as fast as you can.
