# hoplens

The request-journey visualizer for Node.js backends. One-line install for Next.js:

```bash
npm i -D hoplens
npx hoplens init
npm run dev
# → http://localhost:3000/__hoplens
```

This is the meta-package. It depends on `@hoplens/next`, `@hoplens/core`, and ships the `hoplens` CLI binary (from `@hoplens/cli`). For Nest / Express / Fastify adapters (planned), pair the direct adapter package with `@hoplens/cli` instead.

See [hoplens.dev](https://hoplens.dev) for docs.
