# e2e

Playwright suite that drives the live Next.js example app against the Hoplens UI and
snapshots the result at three viewport breakpoints:

- `desktop-1600` — 1600×1000
- `tablet-1100` — 1100×820
- `mobile-420` — 420×820 (Pixel 7 UA)

Each project runs two tests:

1. **initial / empty state** — asserts the shell renders, the Routes sidebar fills via
   `GET /api/routes`, and the Traffic tab shows the empty state. Then full-page snapshot.
2. **after a real request** — fires a valid `POST /api/orders` through the live app, waits
   for the SSE-driven trace row to arrive in the sidebar, clicks it, waits for the journey
   canvas to render, and takes a full-page snapshot of the loaded state.

Baselines are OS-specific (Playwright appends `-{platform}` to each file). The committed
baselines in `snapshots/screenshots.spec.ts-snapshots/` were generated on `win32`.
Regenerate for another platform with `pnpm --filter hoplens-e2e snapshots` on that OS.

## Commands

```bash
pnpm --filter hoplens-e2e install:browsers   # one-time, downloads Chromium
pnpm --filter hoplens-e2e e2e                # run Playwright suite, compare to baselines
pnpm --filter hoplens-e2e snapshots          # regenerate baselines
pnpm --filter hoplens-e2e report             # open HTML report after a failure
pnpm --filter hoplens-e2e verify:build       # dev-only guarantee: next build has no Hoplens leaks
pnpm --filter hoplens-e2e verify:install     # install-flow smoke: pack → scratch install → init → doctor
```

The script is named `e2e` (not `test`) on purpose, so repo-wide `pnpm -r test` runs stay
quick — this suite needs Chromium installed and a free port 3100, which the default unit
test sweep shouldn't require.

The suite launches `next dev` via Playwright's `webServer` config (`reuseExistingServer`
locally, fresh in CI). If a stale `next dev` is already bound to port 3100, stop it before
re-running — Next 16 refuses to spin up a second dev server on the same cwd.

## verify:build — dev-only guarantee

`verify:build` runs `next build` on the example app, then walks `.next/server/**` and
fails if it finds either `@hoplens/` (an import of a Hoplens workspace package) or
`withHoplens(` (the config wrap used as a function). The example app's homepage copy
mentions "Hoplens" and a dead `/__hoplens` link, so a plain string grep would false-
positive — this check uses the two patterns that can only appear if a Hoplens module
was actually bundled.

## verify:install — end-to-end install smoke

`verify:install` simulates `npm i -D hoplens` from a greenfield project. It packs all
seven `@hoplens/*` workspaces into tarballs, writes a scratch Next 16 project in a temp
dir with those tarballs as `file:` deps, runs `npm install`, then `npx hoplens init`,
then `npx hoplens doctor` — expecting doctor to exit 0. Temp dirs are cleaned up on
success; pass `--keep` to leave them for inspection.
