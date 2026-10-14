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
pnpm --filter hoplens-e2e e2e                # run suite, compare to baselines
pnpm --filter hoplens-e2e snapshots          # regenerate baselines
pnpm --filter hoplens-e2e report             # open HTML report after a failure
```

The script is named `e2e` (not `test`) on purpose, so repo-wide `pnpm -r test` runs stay
quick — this suite needs Chromium installed and a free port 3100, which the default unit
test sweep shouldn't require.

The suite launches `next dev` via Playwright's `webServer` config (`reuseExistingServer`
locally, fresh in CI). If a stale `next dev` is already bound to port 3100, stop it before
re-running — Next 16 refuses to spin up a second dev server on the same cwd.
