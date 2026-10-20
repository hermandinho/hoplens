---
"@hoplens/express": minor
---

Function hops: a transform cache and a debug log.

- The register hook passes `<stateDir>/transform` to the transform as its cache (the state dir it
  resolves before boot), so a node --watch / tsx watch / nodemon restart with unchanged files parses
  nothing and loads no TypeScript. Off with `HOPLENS_TRANSFORM_CACHE=0` or
  `HOPLENS_OPTIONS='{"transformCache":false}'`.
- `HOPLENS_DEBUG=transform` prints one line per transformed file on stderr; with `HOPLENS_DEBUG` set
  the banner's `function hops:` line ends with `(cache: K hits)` (or `(cache: off)`).
- The refusal note ends with a pointer to `HOPLENS_DEBUG=transform` unless that log is already on.
- The banner waits for the hooks worker's reports before it prints, so `function hops: N fns in M
  files` counts every file loaded before the app listened (a report could trail the first `listen()`
  when the hook had nothing to parse).
