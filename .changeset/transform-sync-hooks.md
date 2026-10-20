---
"@hoplens/transform": patch
"@hoplens/express": patch
"@hoplens/cli": patch
---

Function hops work the same on Node 20.9, 22.x and 24.x with tsx. On Node 22.22.3+, 24.11.1+ and
25.1+, where tsx 4.23 registers in-thread hooks (`module.registerHooks()`), the ESM hook does too.
Before this, Hoplens' hook always ran inside tsx's there, whatever the flag order. `tsx --import` and
`--import tsx --import` were RAW instead of COMPILED, so the request path lost tsx's output. On 24 the
tsx CommonJS rows also failed (`require.cache` undefined). In-thread, a CommonJS file imported from an
ES module is now wrapped too. `HOPLENS_LOADER_HOOKS=sync|async` overrides the choice. On Node 20.9 /
20.10, which run `--import tsx` after Hoplens, the tsx-first rows are RAW. `hoplens doctor` says so,
says which hook API the Node uses, and flags a `.ts` entry under plain `node` on a Node without type
stripping. The test suites run their child processes on `HOPLENS_TEST_NODE`, and a `runner-matrix` CI
job covers 20.9.0, 22.x and 24.x on Linux and Windows.
