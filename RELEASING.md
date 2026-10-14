# Releasing Hoplens

Hoplens publishes seven packages in lockstep (`hoplens` + six `@hoplens/*`).
Versions are driven by [Changesets](https://github.com/changesets/changesets)
and published by [`.github/workflows/release.yml`](./.github/workflows/release.yml)
on push to `main`.

## Preflight — one-time setup

These steps are manual and only need to happen once (or when a token expires).

- [ ] **`@hoplens` npm org exists** and you have write access. Scope-level
      claim blocks squatting on `@hoplens/*`.
- [ ] **Unscoped `hoplens` name** is claimed (publish a 0.0.x placeholder
      interactively if the first real release hasn't shipped yet).
- [ ] **2FA on your npm account**. Required for publish; a GAT bypasses the
      interactive prompt in CI.
- [ ] **`NPM_TOKEN` GitHub secret** holds a Granular Access Token scoped to
      the `@hoplens` org and the `hoplens` package, with Read-and-Write
      (publish and stage) permission. 90-day expiry is a sane default.
- [ ] **`hoplens.dev`** registered (optional for 0.1.0 — the READMEs
      currently link to the GitHub repo).

## Normal release flow

1. **Make a change** on a feature branch, land it on `develop` via PR.
2. **Add a changeset**:
   ```bash
   pnpm changeset
   ```
   Pick the affected packages and the bump type (`patch` / `minor` / `major`).
   Describe what changed in one or two lines — this becomes the CHANGELOG
   entry. Commit the generated `.changeset/*.md` with your change.
3. **Merge develop → main** when ready to release.
4. **The `release` workflow fires**. If pending changesets exist, it opens
   or updates a **"chore(release): version packages"** PR that bumps
   `package.json` versions and regenerates per-package `CHANGELOG.md`.
5. **Review the Version PR.** If the bumps and changelog read correctly,
   merge it.
6. **The workflow fires again**, this time publishing the updated tarballs
   to npm with sigstore provenance.

All `@hoplens/*` packages plus unscoped `hoplens` are linked in the changesets
config — they always share a version.

## First release (0.1.0) checklist

The first release is special because the packages are at 0.1.0 manually, with
no changesets consumed yet. Changesets takes over from 0.1.1.

1. **Rehearse the pack** — confirm every tarball shape is clean:
   ```bash
   for p in meta cli next core schema transform ui; do
     (cd packages/$p && npm pack --dry-run)
   done
   ```
   Expected sizes (0.1.0, as of this release):

   | package              | tarball | unpacked | files |
   |----------------------|--------:|---------:|------:|
   | `hoplens`            |  3.3 kB |  10.5 kB |    21 |
   | `@hoplens/cli`       | 17.1 kB |  72.4 kB |     4 |
   | `@hoplens/next`      | 52.3 kB | 228.7 kB |    16 |
   | `@hoplens/core`      | 84.9 kB | 310.6 kB |    14 |
   | `@hoplens/schema`    | 31.9 kB | 142.8 kB |     8 |
   | `@hoplens/transform` |  7.4 kB |  42.2 kB |    13 |
   | `@hoplens/ui`        | 26.6 kB |  88.1 kB |     3 |

2. **Run the install-flow smoke** locally to prove the tarball graph
   installs cleanly into a greenfield Next project:
   ```bash
   pnpm --filter hoplens-e2e verify:install
   ```
3. **Verify the dev-only guarantee** passes:
   ```bash
   pnpm --filter hoplens-e2e verify:build
   ```
4. **Merge `develop` → `main`**. The `release` workflow runs, sees no pending
   changesets, and publishes the current `0.1.0` versions directly to npm
   (since the version is ahead of the registry).
5. **Smoke-test the live install** from the registry:
   ```bash
   mkdir /tmp/hop-live && cd /tmp/hop-live
   npm init -y && npm i -D next hoplens
   npx hoplens --version   # should print 0.1.0
   ```

## Troubleshooting

- **`402 Payment Required`** — the `@hoplens` org isn't paid-plan and you're
  trying to publish a private package. Confirm each `@hoplens/*` package.json
  has no `"private": true`.
- **`403 Forbidden`** — `NPM_TOKEN` lacks write access to the package in
  question. Regenerate the GAT with both `@hoplens` scope and `hoplens`
  package name selected.
- **`EPUBLISHCONFLICT`** — the version is already on the registry. Bump via
  changeset or hand-edit `package.json` (only for the manual first cut).
- **"The expected sha of the GitHub Actions workflow does not match"** —
  the Version PR was force-pushed. Close and let changesets reopen it on the
  next workflow run.
- **Provenance attestation missing** — confirm the workflow's `id-token: write`
  permission is set and `NPM_CONFIG_PROVENANCE=true` is in the publish env.

## Rolling back

npm's `npm unpublish` is only allowed within 72 hours of publish, so prefer
`npm deprecate` to warn users off a bad version and publish a patch over the
top as fast as you can.
