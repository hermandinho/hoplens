# Hoplens

The request-journey visualizer for Node.js backends. Install, run one command, and your dev server gains a page that shows every request's full hop-by-hop journey (proxy → router → handler → your functions → fetch/DB → response), with errors pinned to the exact line and a request builder that pre-fills bodies from your Zod schemas.

**Status:** v0.1 under construction. Next.js first, Nest/Express/Fastify adapters planned.

## Install (soon)

```bash
npm i -D hoplens
npx hoplens init
npm run dev
# → open http://localhost:3000/__hoplens
```

## Monorepo layout

```
packages/
  core/        @hoplens/core        framework-agnostic runtime, UI server, OTel bridge
  schema/      @hoplens/schema      Zod static reader
  transform/   @hoplens/transform   exported-fn rewriter + loader + register hook
  ui/          @hoplens/ui          Preact UI (Phase 4 — Phase 1 ships prototype HTML)
  next/        @hoplens/next        withHoplens, Next route scanner, proxy.ts detect
  cli/         @hoplens/cli         bin `hoplens` (init / doctor / remove)
  meta/        hoplens              unscoped meta — depends on @hoplens/{cli,next}
apps/
  web/                              hoplens.dev landing + docs (empty for now)
examples/
  next16-app/                       Turbopack + proxy.ts + Zod v4
e2e/                                Playwright suite (empty for now)
```

See [`AGENTS.md`](./AGENTS.md) for commands, architecture, and the 14 hard-won lessons that shaped the prototype.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
pnpm --filter example-next16-app dev
```

Node ≥ 20.9, pnpm ≥ 9. MIT.
