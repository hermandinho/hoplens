# Changesets

Hoplens uses [Changesets](https://github.com/changesets/changesets) to manage releases.

Workflow:

1. Make your change.
2. Run `pnpm changeset` to describe it. Pick the affected packages and bump type.
3. Commit the generated `.md` file alongside your code.
4. On merge, CI opens a release PR aggregating pending changesets.
5. Merging the release PR publishes to npm.

All `@hoplens/*` packages and the unscoped `hoplens` meta-package are linked — they always share a version.
