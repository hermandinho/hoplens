# @hoplens/cli

Command-line tool for [Hoplens](https://github.com/hermandinho/hoplens). Installs as `hoplens`
on your `PATH` when you add the `hoplens` meta-package to a project. All
commands are idempotent — safe to re-run and safe to run with `--dry-run`
first.

## Install

```bash
npm i -D hoplens
# or run directly without installing
npx hoplens --help
```

## Usage

```text
◆ Hoplens v0.1.0  for Node.js backends

Usage: hoplens <command> [options]

Commands:
  init     wire Hoplens into next.config and instrumentation
  doctor   check that everything is wired correctly
  remove   unwire Hoplens from this project (reverse of init)

Global flags:
  -h, --help      Show this message (or hoplens <cmd> --help)
  -v, --version   Print version and exit

Then run next dev and open /__hoplens.
```

## Commands

### `hoplens init`

Patches `next.config.*` with `withHoplens()` (from `hoplens/next`) and adds
the `hoplens/node` dev-only import to the `instrumentation` `register()`
hook — both routed through the `hoplens` meta so a single `npm i -D hoplens`
is all a user needs. Creates either file if
missing. Preserves user code in both; adds `async` to a sync `register()`
only when it needs to.

```bash
npx hoplens init             # make the changes
npx hoplens init --dry-run   # print the proposed diff, write nothing
```

### `hoplens doctor`

Non-destructive health check. Reports grouped by Environment / Install /
Wiring / Integrations and exits `1` only when something critical would
stop Hoplens from running (missing runtime, missing `withHoplens` wrap,
missing instrumentation hook).

```bash
npx hoplens doctor
```

Example output on a healthy project:

```text
◆ Hoplens doctor

  Environment
  ✓ Node.js 22.20.0
  ✓ Project example-next16-app
  ✓ TypeScript available (Zod pre-fill and function tracing on)

  Install
  ✓ Next.js 16.4.0
  ✓ hoplens runtime is installed

  Wiring
  ✓ next.config.ts uses withHoplens
  ✓ src/instrumentation.ts loads the Hoplens runtime

  Integrations
  • OpenTelemetry not detected — Hoplens runs standalone
  ✓ Zod ^4.6.7 — RequestBuilder will pre-fill from your schemas
  • HOPLENS_PORT not set — Hoplens picks a free port automatically

  All set.
```

### `hoplens remove`

Reverse of `init`. Unwraps the `withHoplens(...)` call in `next.config` and
strips the Hoplens block from `instrumentation.register()`. Deletes files
that `init` created when nothing user-authored remains, so an
`init → remove` round-trip is byte-identical to the pre-init state.
It also deletes the data Hoplens wrote under the build output: the persisted
stats in `<distDir>/cache/hoplens` (from `persist: true`) and
`<distDir>/cache/hoplens.json`.

```bash
npx hoplens remove             # undo init
npx hoplens remove --dry-run   # preview the undo without writing
```

Then `npm rm hoplens` to drop the dependency.
