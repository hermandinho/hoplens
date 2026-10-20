# @hoplens/schema

Static Zod (v3 + v4) interpreter. Reads `z.*` call chains straight from the TypeScript source — no code executed — and produces a JSON-friendly `Shape`, an example value satisfying the parsed constraints, and a human-readable field list for the UI.

`SchemaProject` finds the schemas a handler validates its input with (`Schema.parse(req.body)`,
`safeParse(await req.json())`, …) and resolves them across files: named, default and namespace
imports, re-exports, barrels and aliases, and, opt-in, CommonJS `require` / `module.exports`. Parsed
files are cached by mtime. The Next and Express adapters share it.

Internal to [Hoplens](https://github.com/hermandinho/hoplens). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) instead.
