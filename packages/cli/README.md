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
  init     wire Hoplens into next.config and instrumentation (or the Express dev script)
  doctor   check that everything is wired correctly
  remove   unwire Hoplens from this project (reverse of init)

Global flags:
  -h, --help      Show this message (or hoplens <cmd> --help)
  -v, --version   Print version and exit

Then run next dev (or your Express dev script) and open /__hoplens.
```

## Commands

### `hoplens init`

The framework is detected from `package.json` (`next` or `express`); pass
`--framework next|express` when a project depends on both.

**Express:** adds `--import hoplens/express/register` to `scripts.dev` (else `start:dev`, else
`watch`) and changes nothing else in `package.json`, byte for byte. Supported shapes: `node
[--watch] ...`, `tsx [watch] ...`, `nodemon ...` (wired as `nodemon --exec "node --import
hoplens/express/register" ...`, or inside an existing `--exec "node ..."`), with env prefixes
(`cross-env NODE_ENV=development`) and `&&` chains kept as written: only the command that starts
the app gets the flag. `--import` is used for CommonJS and ESM alike. Other runners (`ts-node-dev`,
`ts-node`, `pm2`, `bun`, `docker`) are left alone and init prints the line to use. With no dev
script it prints the one to add. `scripts.start` and your code are never edited.

**Next.js:** patches `next.config.*` with `withHoplens()` (from `hoplens/next`) and adds
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

On an Express project it checks that `hoplens` is resolvable from the project (with pnpm, use the
`hoplens/express/register` form: `@hoplens/express` isn't hoisted), that Express is 4 or 5, and
that the dev script loads the register hook. It fails when the hook is in `scripts.start` or a
production-looking script, warns when `NODE_OPTIONS` (in a script or a `.env*` file) carries it or
when the dev script sets `NODE_ENV=production`, and notes a `hoplens(app)` call in your entry file.

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

On an Express project `remove` takes the flag `init` added out of the dev script (the script is
byte-identical to before `init`) and deletes `node_modules/.cache/hoplens`.

Then `npm rm hoplens` to drop the dependency.
