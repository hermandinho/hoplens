# e2e

Playwright suite that drives the live Next.js example app against the Hoplens UI and
snapshots the result at three viewport breakpoints:

- `desktop-1600` — 1600×1000
- `tablet-1100` — 1100×820
- `mobile-420` — 420×820 (Pixel 7 UA)

Each project runs three tests:

1. **initial / empty state** — asserts the shell renders, the Overview shows "No traffic yet"
   and the Requests list (`#/requests`) shows its empty state. Then a full-page snapshot of
   the Overview.
2. **after a real request** — fires a valid `POST /api/orders` through the live app, checks
   the response carries `x-hoplens-trace` and a `Server-Timing` `total` entry, waits for that
   trace's row to arrive over SSE in `#/requests`, clicks it, checks the hash is `#/r/<id>`
   and the journey canvas rendered, and takes a full-page snapshot.
3. **after a 500 handler throw** — PATCHes an already-paid order so `payOrder()` throws,
   opens the trace the same way, checks the verdict reads as a failure, and snapshots it.

The tests navigate by hash rather than by clicking view tabs, because the desktop top bar
and the phone bottom tabs (<= 760px) are different elements.

Baselines are OS-specific (Playwright appends `-{platform}` to each file). The committed
baselines in `snapshots/screenshots.spec.ts-snapshots/` were generated on `win32`.
Regenerate for another platform with `pnpm --filter hoplens-e2e snapshots` on that OS.

The committed baselines still show the pre-redesign UI (sidebar + Traffic tab). Regenerate
them with `pnpm --filter hoplens-e2e snapshots` before relying on the comparison; until then
the three screenshot assertions fail by design.

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

The suite launches the Next example's `next dev` on port 3100 (UI port 14983) via
Playwright's `webServer` config (`reuseExistingServer` locally, fresh in CI). Port 3100 is
also the Express example's default `PORT`, and Express serves `/__hoplens/api/meta` too, so
locally Playwright would reuse a running Express example as if it were the Next app: stop it,
or start it on another port (`PORT=3101 pnpm --filter example-express-app dev`), before
running the suite. Likewise stop a stale `next dev` on 3100 — Next 16 refuses to spin up a
second dev server on the same cwd.

## verify:build — dev-only guarantee

`verify:build` runs `next build` on the example app, then walks `.next/server/**` and
fails if it finds either `@hoplens/` (an import of a Hoplens workspace package) or
`withHoplens(` (the config wrap used as a function). The example app's homepage copy
mentions "Hoplens" and a dead `/__hoplens` link, so a plain string grep would false-
positive — this check uses the two patterns that can only appear if a Hoplens module
was actually bundled.

## verify:install — end-to-end install smoke

`verify:install` simulates `npm i -D hoplens` from a greenfield project. It packs the
`hoplens` meta package and every workspace package it depends on, transitively (cli, next,
express, core, schema, transform, ui; the list is read from the `workspace:` dependencies,
not hard-coded), into tarballs, writes a scratch Next 16 project in a temp
dir with the meta tarball as its one `file:` dep (npm `overrides` point the
`@hoplens/*` dependencies at the other tarballs), runs `npm install`, then `npx hoplens init`,
then `npx hoplens doctor` — expecting doctor to exit 0. Temp dirs are cleaned up on
success; pass `--keep` to leave them for inspection.
