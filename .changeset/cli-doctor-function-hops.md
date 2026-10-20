---
"@hoplens/cli": minor
---

`hoplens doctor` for Express has a Function hops section: whether function hops are on and from where
(default, `HOPLENS_AUTOTRACE`, `HOPLENS_OPTIONS`, in the dev script or the environment) and for which
files, what the dev script's runner gets (node `--import` / `-r`, tsx before or after Hoplens, ts-node
CommonJS; ts-node's ESM loader is flagged as untested), the CommonJS-entry-under-`--import` note (moved
here from Wiring), the transform cache's location and size (or why it is off), and how to skip files
with `autoTrace.exclude`.
