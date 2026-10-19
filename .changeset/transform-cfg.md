---
"@hoplens/transform": minor
---

New `@hoplens/transform/cfg` entry: `buildCfg(ts, text, fileName)` builds a structured
control-flow model of every function in a file from the TypeScript AST, for the request path's
per-decision truth. Statements stay grouped in blocks; decisions keep their arms in source order
(`if` / `else if` chains flattened, `switch` cases with fall-through, `?:`, and `&&` / `||` / `??`
marked shown when the right side has a side effect or is the value returned); loops of every kind
with their labels; `try` / `catch` / `finally`; `return`, `throw` and labeled `break` /
`continue`. Await points are counted on their statements, nested functions and callbacks are
functions of their own (linked by id, never inlined), and type-only TypeScript is skipped. Every
node has source offsets (first token) and lines; a function lists the offsets V8 may report as its
start. Pure (TypeScript is passed in), cached per file text, capped at 2000 nodes per function
(the rest folds), 300 levels of nesting and 250ms per file; a file whose nesting still overflows
the stack is `truncated` with no functions.

Decisions in code their statement may skip are `guarded`: the tail of an optional chain after
`?.`, destructuring and parameter defaults, a for-of / for-in binding (per pass), a logical
assignment's right side. `&&=` / `||=` / `??=` are never shown (V8 keeps no counter for their right
side). A function with parameter defaults or patterns is flagged `paramInit`; functions created in
parameter defaults and class static blocks are in the model; class field initializers keep their
functions but not their decisions (V8 runs them elsewhere); `with (o) body` is its body.
