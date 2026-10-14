# @hoplens/transform

Source-level transform that re-binds every exported function in a module to a traced wrapper **without moving a single line or column** — source maps stay valid.

Ships three entries:

- `@hoplens/transform` — pure functions (`shouldTrace`, `transformSource`).
- `@hoplens/transform/loader` — webpack / Turbopack loader entry. Used by `@hoplens/next`.
- `@hoplens/transform/register` — Node `module.register()` hook stub for non-bundled frameworks.

Internal to [Hoplens](https://github.com/hermandinho/hoplens). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) instead.
