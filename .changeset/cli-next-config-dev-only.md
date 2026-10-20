---
"@hoplens/cli": minor
"hoplens": minor
---

`hoplens init` on Next.js no longer imports `hoplens/next` at the top of `next.config`, so `next build`
and `next start` work on an install without dev dependencies (they failed with "Cannot find module
'hoplens/next'"). init exports a function that returns your config unchanged outside
`PHASE_DEVELOPMENT_SERVER` and loads `withHoplens` lazily in `next dev`, for `.ts`, `.mts`, `.mjs`,
`.js` (CommonJS or ESM) and `.cjs`; `.ts` files use `"hoplens/next" as string` (and
`"hoplens/node" as string` in `instrumentation.ts`) so next build's type check passes once hoplens is
pruned. Re-running init upgrades a config written by an older init (keeping its specifier and
options) and is a no-op after that; `remove` gives back the original config byte for byte from
either form; `doctor` warns on the old form ("next build/start without dev dependencies will fail;
run npx hoplens init to upgrade") and on a plain-literal `hoplens/node` import in `instrumentation.ts`.
Behind the gate, `withHoplens(config, { enabled: true })` no longer turns Hoplens on outside `next dev`.
