<img src="https://raw.githubusercontent.com/hermandinho/hoplens/main/assets/logo-mark.svg" alt="Hoplens logo" width="64" height="64">

# hoplens

[![npm](https://img.shields.io/npm/v/hoplens.svg)](https://www.npmjs.com/package/hoplens)
[![license](https://img.shields.io/npm/l/hoplens.svg)](https://github.com/hermandinho/hoplens/blob/main/LICENSE)

The request-journey visualizer for Node.js backends. One command, and
`next dev` gains a page showing every request's full hop-by-hop journey —
proxy → router → handler → your functions → fetch/DB → response — with
errors pinned to the exact `.ts` line and a request builder that pre-fills
bodies from your Zod schemas.

Each request opens with one sentence saying what made it slow or fail and
the line to look at. Findings (N+1, duplicate calls, parallelizable chains,
uncached fetches, swallowed errors, …) are ranked across requests, every dev
rebuild gets a per-route "did this edit make it slower?" verdict, and any
two requests can be compared span by span or replayed ×10. Dev responses
carry `Server-Timing` and `x-hoplens-trace` headers for the browser's
Network panel. Press `?` in the UI for the keys, `Ctrl/Cmd+K` for the
command palette.

Options (`insights`, `serverTiming`, `persist`, …), the search language, the
keyboard map and the JSON API are documented in the
[repo README](https://github.com/hermandinho/hoplens#readme).

## Install

```bash
npm i -D hoplens
npx hoplens init     # wires withHoplens() + instrumentation.register()
npm run dev
# open http://localhost:3000/__hoplens
```

Requires Next.js 15.3+ and Node 20.9+. Next 16 is the primary target.

## Commands

- `npx hoplens init` — wire into `next.config` and `instrumentation` (idempotent)
- `npx hoplens doctor` — check that everything is in place
- `npx hoplens remove` — reverse of `init` (byte-identical round-trip)

All three support `--dry-run`. Run `npx hoplens <cmd> --help` for details.

## What ships

This meta-package pulls in:

- [`@hoplens/cli`](https://www.npmjs.com/package/@hoplens/cli) — the `hoplens`
  binary.
- [`@hoplens/next`](https://www.npmjs.com/package/@hoplens/next) — `withHoplens()`
  config wrap and the Next route scanner.
- [`@hoplens/core`](https://www.npmjs.com/package/@hoplens/core) — the
  framework-agnostic runtime that drives the UI.

- [`@hoplens/express`](https://www.npmjs.com/package/@hoplens/express) — the
  Express 4/5 adapter (early preview), as `hoplens/express` and
  `node -r hoplens/express/register` (or `--import`).

For Nest / Fastify (planned), pair the direct adapter package with
`@hoplens/cli` instead.

## Dev-only guarantee

The instrumentation hook is gated by `NODE_ENV === "development"` and the
production build is CI-asserted to contain zero Hoplens runtime. Shipping
impossible.

## License

MIT. See the [repo](https://github.com/hermandinho/hoplens) for source and docs.
