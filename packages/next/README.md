# @hoplens/next

[![npm](https://img.shields.io/npm/v/@hoplens/next.svg)](https://www.npmjs.com/package/@hoplens/next)

Next.js adapter for [Hoplens](https://github.com/hermandinho/hoplens). Wrap
your Next.js config to light up the `/__hoplens` request-journey view during
`next dev`.

> Most users should install [`hoplens`](https://www.npmjs.com/package/hoplens)
> instead — the meta-package wires everything (including this adapter) via
> `npx hoplens init`. Install this package directly only if you need manual
> control over the wiring.

## Install

```bash
npm i -D @hoplens/next
```

## Usage

**`next.config.ts`**
```ts
import { withHoplens } from "@hoplens/next";

export default withHoplens({ /* your Next.js config */ });
```

**`instrumentation.ts`** (or `src/instrumentation.ts` if your app is under `src/`)
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {
    await import("@hoplens/next/node");
  }
}
```

Then `next dev` and open `http://localhost:3000/__hoplens`.

## Options

The second argument takes Hoplens options:

```ts
export default withHoplens(nextConfig, {
  insights: { thresholds: { nPlusOneMin: 10 }, disable: ["logs-on-success"] },
  serverTiming: true, // Server-Timing + x-hoplens-trace on dev responses (default)
  persist: true,      // keep stats, edits and verdicts across dev restarts (default false)
});
```

Every option (`port`, `autoTrace`, `redact`, `profiles`, `maxTraces`,
`insights`, `serverTiming`, `persist`, `lateSpanGraceMs`, `allowRemote`) is
documented in the [repo README](https://github.com/hermandinho/hoplens#options).

## What it does

- `withHoplens()` adds the Next.js config bits Hoplens needs (webpack / Turbopack
  carve-outs, external bundling guards for the runtime).
- `@hoplens/next/node` is the dev-only entry that bootstraps the capture engine,
  scans your routes (`app/**/route.ts`, `pages/api/**/*.ts`, proxy / middleware),
  and starts the UI server on a free port.

Requires Next.js 15.3+. Next 16 is the primary target.

## Request path (Trace path)

Opt-in: `HOPLENS_PATH=1 next dev`, or **Enable request path** in the Path tab (or
`hoplens init --path`), which writes `.next/cache/hoplens/path.json` (withHoplens'
`stateDir` moves it) and applies at the next start of `next dev`. `HOPLENS_PATH`
always wins over the switch. With it on, the instrumentation hook starts V8 block
coverage before the first request's proxy and route code, and **Trace path**
replays a GET once and shows which branches of your route and lib functions ran,
mapped through the bundler's source maps (Turbopack and `--webpack`). Coverage
stays on while `next dev` runs, so CPU-heavy code runs slower.

After an edit, Turbopack rewrites its chunks in place and runs the edited module
as an HMR update whose text exists only in V8: those functions are UNKNOWN
(`stale-chunk`) until you restart `next dev`, or set `HOPLENS_PATH_DEBUGGER=1` to
read the text from V8 instead. Under `--webpack` the re-emitted bundle holds the
text V8 runs, so edited code maps again from disk.

A lib that runs in two bundled copies in one request (the route's and the
proxy's) is UNKNOWN (`bundle-copies`); a chunk over 4 MB, or one whose map cannot
be read, is UNKNOWN (`unmapped`) with the chunk named in the trace's warnings.

## Dev-only guarantee

The `NODE_ENV === "development"` gate on the import is non-negotiable. The
Hoplens runtime is CI-asserted to be absent from `.next/server/**` after
`next build` — see `pnpm --filter hoplens-e2e verify:build`.

## License

MIT. See the [repo](https://github.com/hermandinho/hoplens) for source and docs.
