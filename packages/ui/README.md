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

## Journey pane modes

A trace's Journey pane has three modes, picked by the chips above it: **Flame**
(nested boxes, width is duration) and **Tree** (one indented row per span),
which `t` toggles, and **Path**, which `x` toggles. On a phone the span canvas
is always Tree.

The Path view shows which side of each decision the request took. On a normal GET
trace it offers **Trace path** (a replay recorded as a new path trace) or, when
the request path is off, **Enable request path** with *Restart your dev server to
apply* and Undo. On a path trace it shows the verdict line (where the request
exited and through which decision), the EXACT / blended / UNKNOWN evidence, and
one lane per function with its decision chips; `j` / `k` move between lanes and
`Enter` opens the lane's function.

![The Path view on a path trace of GET /api/products/999: the exit verdict, the handler lane open in the Flow panel with the taken arm solid and the not-run arm dashed](../../docs/images/path-flow.png)

The function panel sits beside the trail at 1100px and wider, in its place
(behind a breadcrumb) below that. It has two views, which `v` toggles:

- **Flow**: the function's control-flow chart, the taken arm solid, arms that
  did not run dashed, runs of lines that did not run folded, and an evidence
  footer.
- **Source**: the function's source with a hit-count gutter and chips for the
  decision taken and the request's exit.

`u` unfolds everything (again: folds back), `Backspace` goes back to the caller
or the trail, `Esc` closes the panel.

Internal to [Hoplens](https://github.com/hermandinho/hoplens). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens),
[`@hoplens/next`](https://www.npmjs.com/package/@hoplens/next) or
[`@hoplens/express`](https://www.npmjs.com/package/@hoplens/express) instead.
