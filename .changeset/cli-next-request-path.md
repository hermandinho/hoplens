---
"@hoplens/cli": minor
"hoplens": minor
---

`hoplens init` asks about request path tracing for Next projects too (in a terminal, default no;
`--path` / `--no-path` without asking) and writes the flag where `@hoplens/next` reads it:
`.next/cache/hoplens/path.json` (next.config's `distDir`, or withHoplens' `stateDir`, when they are
plain strings). `hoplens doctor` reports the request path for Next as it does for Express (HOPLENS_PATH
in `scripts.dev` or the environment wins over the flag; c8 keeps it disabled), and `hoplens remove`
deletes the flag with `.next/cache/hoplens`.
