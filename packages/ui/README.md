# @hoplens/ui

The Hoplens UI — Preact + Vite, built to a single inlined HTML file served
by `@hoplens/core`'s UI server at `/__hoplens`. No external resources, no
fonts, no CDN; everything in one file so the dashboard stays offline-friendly
and loads instantly regardless of network conditions.

Four hash-routed views (Overview, Requests, Queries, Changes) plus Compare,
each a list beside a subject; on screens ≤ 760px they become pages with bottom
tabs. Keys come from one scoped keymap that also generates the `?` sheet, the
footer hints and the `Ctrl/Cmd+K` palette's actions. Colours and type come
only from `src/styles/tokens.css`; `pnpm --filter @hoplens/ui test` first
runs `scripts/check-tokens.mjs` (no colour literals outside tokens, hue
separation between families, contrast on every surface), then the unit tests.

Internal to [Hoplens](https://github.com/hermandinho/hoplens). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) or
[`@hoplens/next`](https://www.npmjs.com/package/@hoplens/next) instead.
