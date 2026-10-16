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

## Dev-only guarantee

The `NODE_ENV === "development"` gate on the import is non-negotiable. The
Hoplens runtime is CI-asserted to be absent from `.next/server/**` after
`next build` — see `pnpm --filter hoplens-e2e verify:build`.

## License

MIT. See the [repo](https://github.com/hermandinho/hoplens) for source and docs.
