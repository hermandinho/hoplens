---
"@hoplens/transform": minor
---

Transform cache and debug log for `register()`.

- New `cacheDir` option: both loaders (the ESM hook in the hooks worker, the CommonJS layer on the main
  thread) look each file up in `<cacheDir>/<sha1>.hlc` (not `.json`, which nodemon watches) before they parse it, so a restart with
  unchanged files loads no TypeScript in either thread. The key covers the source bytes (and, for
  COMPILED mode, the raw file on disk), the path relative to the root, the mode (`raw`, `compiled`,
  `cjs`), the preset, the include / exclude globs, the transform build (`dist/index.js`) and the
  TypeScript package it would load. Entries store the same-length `const` -> `let  ` swaps and the
  appended text, checked against the source again on a hit; corrupt, partial or mismatched entries are
  misses; a `none` computed while TypeScript failed to load is not stored. Written atomically, bounded
  to 5000 entries / 50 MB (least recently used dropped first, by an asynchronous scan at most every 10
  minutes per dir), off with `HOPLENS_TRANSFORM_CACHE=0`. Request-path retention is unchanged: it keeps the loader's text.
- `HOPLENS_DEBUG=transform` (or the new `debug` option) prints one line per in-scope file with export syntax to stderr
  (`hoplens:transform src/a.ts mode=compiled wrapped=2 cache=hit 0.3ms`), with `refused=<reason>`
  and a short label, and `ts=loaded(hooks|main)` on the file that made a thread load TypeScript.
  New exports: `debugLine()`, `transformDebug()`, `REFUSAL_LABELS`, and `typescriptLoaded()` from the
  main entry.
- With `verbose` (implied by `debug`) reports carry `mode`, `cache`, `ms` and `ts`, and files parsed
  with nothing to wrap are reported as `type: "none"`. Without it reports are unchanged.
- New `flushReports(cb, timeoutMs?)`: runs `cb` once every report the ESM hook posted so far reached
  `onReport` (the hooks worker answers on the same port, after them), or after the timeout.
