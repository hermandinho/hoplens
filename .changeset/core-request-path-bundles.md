---
"@hoplens/core": minor
---

Request path through bundles (`RuntimeConfig.path.scripts`, `bundledScripts()`): a capture keeps only
the coverage scripts that hold project code (Turbopack chunks, Turbopack HMR updates, webpack
eval-source-map modules; React's `about://React/*` fakes, empty-URL `new Function` code and framework
scripts are dropped by URL, decided once per script id) and maps each project file through its
bundle's source map with P5's containment rules: a Turbopack chunk's sidecar sectioned map (only the
file's own section), a webpack module's inline map, absolute Windows source paths and
`turbopack:///[project]/` sources included. The text V8 ran comes from disk only while it provably is
V8's (the script was seen after the file's last write, and V8's script length is the text's);
otherwise from V8 with `HOPLENS_PATH_DEBUGGER=1` (a rewritten Turbopack chunk is re-anchored module
by module), else the function is UNKNOWN with the new reason `stale-chunk` (only when the bundler rewrote the file
after V8 loaded it; a text with no source map, a chunk over 4 MB or a map that cannot be read is
`unmapped` with the chunk named in the warnings, and a failed map read is retried on the next capture).
A map whose sourcesContent is the file vouches for a file edited after the process started. A file
whose code ran in two bundled copies (two webpack layers) is UNKNOWN with the new reason
`bundle-copies`. A file under the server output is kept only when it holds a project module, so Next's
framework chunks and `webpack-runtime.js` are not counted in `window.scripts`. The payload's `window.bundled` reports the take's
script kinds, kept files and what resolving cost (take times were already in `window.takeMs`).

Untraced framework requests (Next's `/_next/*`, `/__nextjs*`) are reported in `window.internal`: they
are not foreign traffic by themselves, but they rule out the "local binding" PARTIAL verdict and are
named when a function ran more often than its hops. `TraceStore.noteInternal` / `onInternal` carry
them. New exports: `startCoverage`, `persistDir`, the sticky-switch helpers of `path/flag.ts`
(`flagPathControl`, `readPathFlagFile`, `writePathFlagFile`, `removePathFlagFile`), and
`CoverageSource.take(keep)` now passes the script as `keep`'s second argument. Core loads builtins
through `process.getBuiltinModule` when it has one, so a bundler that inlines core (Turbopack, for a
workspace-linked core) does not break coverage. The toggle API's 409 `unsupported` no longer says
"Express only".
