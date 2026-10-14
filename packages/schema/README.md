# @hoplens/schema

Static Zod (v3 + v4) interpreter. Reads `z.*` call chains straight from the TypeScript source — no code executed — and produces a JSON-friendly `Shape`, an example value satisfying the parsed constraints, and a human-readable field list for the UI.

Internal to [Hoplens](https://github.com/hermandinho/hoplens). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) instead.
