---
"@hoplens/express": minor
"@hoplens/core": minor
"@hoplens/ui": minor
"@hoplens/cli": minor
---

Request path: a sticky one-click switch. The path stays off by default; turning it on no longer needs
`HOPLENS_PATH=1` in every shell.

- `@hoplens/express`: the register hook reads `<stateDir>/path.json`
  (`{"enabled":true,"since":ISO,"by":"ui"|"init"}`; `node_modules/.cache/hoplens` by default,
  honouring `HOPLENS_OPTIONS` `stateDir` / `root`) before coverage would start. `HOPLENS_PATH=1` / `0`
  always wins, then the flag, else off; the dev gate is unchanged. With the path off the hook only
  reads that one small file. The banner says `request path: on (flag; disable in the Path tab)` or
  `request path: on (HOPLENS_PATH)`.
- `@hoplens/core`: `RuntimeConfig.path.control` (`PathControl`) is an adapter's switch.
  `POST /api/path/enable` and `/api/path/disable` write / remove the flag atomically and answer the
  new `meta.path`. Loopback callers only (even with `allowRemote`), and a non-local `Origin` gets
  403; 409 `env` when `HOPLENS_PATH` decided, 409 `unsupported` without a control (Next.js: Express
  only), 500 `write-failed`. `meta.path` gains `source` (`env` | `flag` | `default`) and `pending`
  (`on` | `off`) until the restart applies a toggle.
- `@hoplens/ui`: the Path off state has an **Enable request path** button (block coverage from
  start; CPU-heavy code runs slower), then "Restart your dev server to apply (saving a file restarts
  node --watch)" with an `on at next start` badge and Undo. On via the flag, the pane's footer has a
  Disable link (`off at next start` and Keep it on after). Set by `HOPLENS_PATH`, it says so and
  offers no toggle. The copyable env command stays as the secondary option.
- `@hoplens/cli`: `hoplens init` (Express) asks "Enable request path tracing? (block coverage;
  slower for CPU-heavy code) [y/N]" in a terminal (default no; never asked without a TTY),
  `--path` / `--no-path` answer it, and `--dry-run` prints the flag instead of writing it. `remove`
  deletes the flag (with the state dir). `doctor` reports `request path: on (flag)`,
  `on (HOPLENS_PATH)` or `off`, and warns when it would be on with `NODE_V8_COVERAGE` set or when
  the flag file is invalid.
