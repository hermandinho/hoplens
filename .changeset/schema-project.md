---
"@hoplens/schema": minor
"@hoplens/next": patch
---

`@hoplens/schema` exports `SchemaProject`, the schema finder and cross-file resolver the Next
adapter used internally (imports, re-exports, barrels, aliases, namespace imports, a per-mtime
source-file cache), plus `fieldsOf`, `scriptKind`, `objectMember`, `PARSE_METHODS` and the
`SchemaInfo` type. Opt-in options follow CommonJS `require` / `module.exports`, resolve a default
import to `export default function`, and add a body-input pattern; the Express adapter uses them.
`@hoplens/next` now calls it, with no change in what it finds. A schema name shadowed by a function
parameter or local binding is no longer resolved to the top-level declaration, and CommonJS
re-export barrels (`module.exports = require("./x")`) are followed. A new opt-in
`memberDeclarations` option (used by Express, off for Next) locates a member-access schema
(`ns.Body`, a required module's `S.Body`, an object literal's `schemas.Body` or `a.b.Body`) at its
declaration instead of the call site, and reads object-literal members for their shape;
`localBinding` is exported for adapters.
