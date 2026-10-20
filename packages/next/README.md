# @hoplens/next

[![npm](https://img.shields.io/npm/v/@hoplens/next.svg)](https://www.npmjs.com/package/@hoplens/next)

Next.js adapter for [Hoplens](https://github.com/hermandinho/hoplens). Wrap
your Next.js config to light up the `/__hoplens` request-journey view during
`next dev`.

> Most users should install [`hoplens`](https://www.npmjs.com/package/hoplens)
> instead: the meta-package wires everything (including this adapter) via
> `npx hoplens init`. Install this package directly only if you need manual
> control over the wiring.

![The journey of GET /api/db/products under next dev: Next.js spans folded, proxy, handler, function and DB hops, and the N+1 verdict at route.ts:19](../../docs/images/next-journey.png)

## Install

```bash
npm i -D @hoplens/next
```

## Usage

**`next.config.ts`** (Hoplens is a dev dependency, so load it in `next dev` only: `next build` and
`next start` then work on an install without dev dependencies)
```ts
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = { /* your Next.js config */ };

export default async (phase: string, ctx: { defaultConfig: NextConfig }) => {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;
  const { withHoplens } = await import("@hoplens/next" as string);
  return withHoplens(nextConfig)(phase, ctx);
};
```

`as string` keeps `next build`'s type check from resolving the module (TS2307 when dev dependencies
are pruned). In `next.config.mjs` import `next/constants.js`.

**`instrumentation.ts`** (or `src/instrumentation.ts` if your app is under `src/`)
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {
    await import("@hoplens/next/node" as string);
  }
}
```

Then `next dev` and open `http://localhost:3000/__hoplens`.

With the `hoplens` meta-package the same two entries are `hoplens/next` and
`hoplens/node`; `hoplens init` writes those.

## Options

The second argument takes Hoplens options:

```ts
// inside the dev-only branch above
return withHoplens(nextConfig, {
  insights: { thresholds: { nPlusOneMin: 10 }, disable: ["logs-on-success"] },
  serverTiming: true, // Server-Timing + x-hoplens-trace on dev responses (default)
  persist: true,      // keep stats, edits and verdicts across dev restarts (default false)
})(phase, ctx);
```

Every option (`enabled`, `port`, `autoTrace`, `redact`, `profiles`, `maxTraces`,
`insights`, `serverTiming`, `persist`, `lateSpanGraceMs`, `allowRemote`) is
documented in the [repo README](https://github.com/hermandinho/hoplens#configuration).
Two of them matter here:

- `enabled` overrides the gate. By default `withHoplens` turns Hoplens on only in
  the `next dev` phase, and never with `HOPLENS=0`. Off, it returns your config
  unchanged. Behind the `PHASE_DEVELOPMENT_SERVER` branch above it only runs in
  `next dev`, so `enabled: true` cannot turn it on elsewhere.
- `stateDir` moves the persisted stats and the request path flag out of
  `.next/cache/hoplens` (relative to the project root, or absolute). The runtime
  reads it, but it is not declared on the `HoplensOptions` type (a static import
  of `withHoplens` needs a cast; the lazily loaded one above is untyped). Write it
  as a plain string so `hoplens init` and `doctor` find it too:

  ```ts
  return withHoplens(nextConfig, { persist: true, stateDir: ".hoplens" })(phase, ctx);
  ```

## What it does

- `withHoplens()` adds the Next.js config bits Hoplens needs (webpack / Turbopack
  carve-outs, external bundling guards for the runtime).
- `@hoplens/next/node` is the dev-only entry that bootstraps the capture engine,
  scans your routes (`app/**/route.ts`, `pages/api/**/*.ts`, proxy / middleware),
  and starts the UI server on `http://127.0.0.1:4983` (`port` or `HOPLENS_PORT`;
  when that port is taken, the first free one of the next 10). The same view is
  served at `/__hoplens` on the `next dev` port.

Requires Next.js 15.3+. Next 16 is the primary target.

## Request path (Trace path)

Opt-in: `HOPLENS_PATH=1 next dev`, **Enable request path** in the Path view (press `x`
on a request), or `hoplens init --path`. The switch and init write
`.next/cache/hoplens/path.json` (`stateDir` moves it), applied at the next start of
`next dev`. `HOPLENS_PATH` always wins over the switch. With it on, the
instrumentation hook starts V8 block coverage before the first request's proxy and
route code, and **Trace path** replays a GET once and shows which branches of your
route and lib functions ran, mapped through the bundler's source maps (Turbopack and
`--webpack`). Coverage stays on while `next dev` runs, so CPU-heavy code runs slower.

After an edit, Turbopack rewrites its chunks in place and runs the edited module
as an HMR update whose text exists only in V8: those functions are UNKNOWN
(`stale-chunk`) until you restart `next dev`, or set `HOPLENS_PATH_DEBUGGER=1` to
read the text from V8 instead. Under `--webpack` the re-emitted bundle holds the
text V8 runs, so edited code maps again from disk.

A lib that runs in two bundled copies in one request (the route's and the
proxy's) is UNKNOWN (`bundle-copies`); a chunk over 4 MB, or one whose map cannot
be read, is UNKNOWN (`unmapped`) with the chunk named in the trace's warnings.

## Dev-only guarantee

The `NODE_ENV === "development"` gate on the import is non-negotiable.
`@hoplens/next/node` also refuses to start under `NODE_ENV=production` unless
`HOPLENS_FORCE=1`, and never starts with `HOPLENS=0`. The Hoplens runtime is
CI-asserted to be absent from `.next/server/**` after `next build`: see
`pnpm --filter hoplens-e2e verify:build`.

## License

MIT. See the [repo](https://github.com/hermandinho/hoplens) for source and docs.
