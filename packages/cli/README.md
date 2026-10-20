# @hoplens/cli

Command-line tool for [Hoplens](https://github.com/hermandinho/hoplens). Installs as `hoplens`
on your `PATH` when you add the `hoplens` meta-package to a project. `init` and `remove` are
idempotent and take `--dry-run`; `doctor` only reads.

## Install

```bash
npm i -D hoplens
# or run directly without installing
npx hoplens --help
```

## Usage

`hoplens --help` (or `hoplens` with no command):

```text
◆ Hoplens v0.2.0  for Node.js backends

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

| Command | Flags |
|---|---|
| `hoplens init` | `--dry-run`, `--framework next\|express` (or `--framework=express`), `--path` or `--no-path` (not both) |
| `hoplens doctor` | `--framework next\|express` |
| `hoplens remove` | `--dry-run`, `--framework next\|express` |

The framework is detected from `package.json` (`next` or `express`, devDependencies too);
`--framework` is needed only when a project depends on both. A project with neither is refused.

## Commands

### `hoplens init`

**Next.js:** makes `next.config.*` load `withHoplens()` (from `hoplens/next`) in `next dev` only
and adds the `hoplens/node` dev-only import to the `instrumentation` `register()`
hook — both routed through the `hoplens` meta so a single `npm i -D hoplens`
is all a user needs. Creates either file if
missing. Preserves user code in both; adds `async` to a sync `register()`
only when it needs to.

`hoplens` is a dev dependency, so the config must not import it when Next reads it for `next build`
or `next start`. init replaces only the exported expression (`export default <expr>` /
`module.exports = <expr>`) with a function that returns your config unchanged outside
`PHASE_DEVELOPMENT_SERVER` and loads `hoplens/next` lazily in it:

```ts
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = { reactStrictMode: true };

export default async (phase: string, ctx: { defaultConfig: NextConfig }) => {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;
  // Hoplens is a dev dependency: only `next dev` loads it
  const { withHoplens } = await import("hoplens/next" as string);
  return withHoplens(nextConfig)(phase, ctx);
};
```

- `.ts` / `.mts` get `"hoplens/next" as string` (a plain literal fails `next build`'s type check,
  TS2307, once dev dependencies are pruned); `instrumentation.ts` gets `"hoplens/node" as string` for
  the same reason. `.mjs`, `.mts` and an ESM `.js` import `next/constants.js` (Node ESM refuses the
  bare `next/constants`); CommonJS `require`s both, `hoplens/next` inside the function.
- An exported expression that is not a plain identifier (`{ ... }`, `withBundleAnalyzer(config)`) is
  kept as a `const config = ...` inside the function. A function config (an arrow, or a top-level
  function binding) is called with `(phase, ctx)` outside dev and handed to `withHoplens` in it.
- No try/catch: production never resolves hoplens, and in dev a missing `hoplens` fails loudly.
  `withHoplens(config, { enabled: true })` no longer turns Hoplens on outside `next dev`.
- **Upgrade.** A config in the pre-0.3 form (a sole `import { withHoplens } from "hoplens/next"`,
  or `@hoplens/next`, at the top and `withHoplens(config[, options])` exported) is rewritten to the
  form above, keeping the specifier and the options; the `.ts` instrumentation block init wrote is
  switched to `as string`. A top-level import init can't take over (more names, `import type`) is
  left alone with the snippet to use, and doctor keeps warning. A second init is a no-op.

**Express:** adds `--import hoplens/express/register` to the first of `scripts.dev`,
`scripts.start:dev` and `scripts.watch` that exists, and changes nothing else in `package.json`,
byte for byte, so `remove` can give the script back exactly. Supported shapes:

- `node [--watch] ...` and `tsx [watch] ...`: the flag goes right after the runner.
- `nodemon ...`: wired as `nodemon --exec "node --import hoplens/express/register" ...`, or inside an
  existing `--exec "node ..."` / `--exec "tsx ..."`.
- Env prefixes (`NODE_ENV=development`, `cross-env`, `env`) and `npx` / `pnpm exec` launchers are
  kept as written. In an `&&` / `||` / `;` chain the last command that starts a runner is the app's:
  only it gets the flag (and when that runner is one init doesn't edit, nothing is edited).

Everything else is left alone and init prints why, with the line to use where there is one:

| Script | What init prints |
|---|---|
| `ts-node`, `ts-node-dev`, `tsnd` | the script with `-r hoplens/express/register` after the runner |
| `pm2`, `pm2-dev`, `pm2-runtime` | the script with `--node-args="--import hoplens/express/register"` |
| `bun`, `bunx`, `deno` | not supported by the register hook: run the app with node, or call `hoplens(app)` |
| `docker`, `docker-compose`, `podman`, `forever`, `nest`, `vite-node`, `babel-node`, `swc-node`, `ts-node-esm` | add the flag to the node command that starts your app, or call `hoplens(app)` |
| nodemon running `.ts` files, a nodemon config with its own `exec` or a `--config` file, an unquoted `--exec` value | make nodemon start node with the flag |
| `npm run x`, `pnpm x`, `yarn x` | add the flag to the script that starts your app |
| two node processes started side by side with `&` | add the flag to the one that starts your app |

With no dev script it prints the one to add. `scripts.start` and your code are never edited.

```text
$ npx hoplens init
◆ Hoplens init

  ✓ Added --import hoplens/express/register to scripts.dev
Enable request path tracing? (block coverage; slower for CPU-heavy code) [y/N] y
  ✓ Enabled request path tracing (node_modules/.cache/hoplens/path.json); block coverage runs from
the app's start, so CPU-heavy code runs slower. HOPLENS_PATH=0 overrides it

Done. Run npm run dev and open http://localhost:3100/__hoplens
```

**The request path question.** In a terminal, after wiring either framework, init asks whether to
turn on request path tracing (Trace path). Yes writes the same sticky flag that **Enable request
path** in the UI's Path view writes, read at each start:

- Express: `node_modules/.cache/hoplens/path.json`, or `path.json` in the `stateDir` that
  `HOPLENS_OPTIONS` names (in the dev script or the environment).
- Next.js: `.next/cache/hoplens/path.json` (next.config's `distDir`, or withHoplens' `stateDir`,
  when they are plain strings).

The default is no. Nothing is asked when stdin or stdout is not a terminal (CI), when the flag is
already there, or when `HOPLENS_PATH` is set in the dev script or the environment (it always wins over
the flag at boot). `--path` writes the flag without asking, `--no-path` skips the question and
removes the flag; both still act while `HOPLENS_PATH` is set, and say the flag has no effect then.
`--dry-run` prints the file instead of writing it.

```bash
npx hoplens init             # make the changes
npx hoplens init --dry-run   # print the proposed diff, write nothing
npx hoplens init --path      # also enable request path tracing, no question (Next.js or Express)
npx hoplens init --no-path   # no question; remove the flag if it is there
```

### `hoplens doctor`

Non-destructive health check. Reports grouped by Environment / Install / Wiring / Function hops
(Express only) / Integrations and exits `1` only when something critical would stop Hoplens from
running (Node below 20.9, missing runtime, missing `withHoplens` wrap, missing instrumentation hook,
an Express dev script without the register hook).

```bash
npx hoplens doctor
```

On a Next.js project, Wiring checks the `withHoplens` wrap, the instrumentation import and its
`NODE_ENV === "development"` gate, and that `instrumentation.*` sits next to `app/` / `pages/`. It
warns (without failing) when `next.config` imports `hoplens/next` at the top (*next build/start
without dev dependencies will fail; run npx hoplens init to upgrade*) and when `instrumentation.ts`
imports `hoplens/node` as a plain string literal.

On an Express project, Install checks that Express is 4 or 5 and that `hoplens` is resolvable from
the project (with pnpm, use the `hoplens/express/register` form: `@hoplens/express` isn't hoisted).
Wiring checks that the dev script loads the register hook. It fails when the hook is in
`scripts.start` or a production-looking script, warns when `NODE_OPTIONS` (in a script or a `.env*`
file) carries it or when the dev script sets `NODE_ENV=production`, and notes a `hoplens(app)` call in
your entry file.

For both, Wiring reports the request path as the next start will see it: `request path: on
(HOPLENS_PATH)` (set in the dev script or the environment), `request path: on (flag)` (the sticky
flag), or `request path: off`. It warns when the path would be on while `NODE_V8_COVERAGE` (c8) is
set, which keeps it disabled, and when the flag file is not valid.

**Function hops** (Express, when the dev script loads the register hook or `hoplens(app)` is called):

- whether they are on (`HOPLENS_AUTOTRACE`, `autoTrace` in `HOPLENS_OPTIONS`) and for which files;
  with only `hoplens(app)`, that they are off because your modules loaded first;
- what the dev script's runner gets: `node --import` and `node -r` (RAW, plus the CommonJS layer),
  tsx before Hoplens (COMPILED), Hoplens before tsx (RAW), ts-node's CommonJS register; ts-node's
  ESM loader is warned about as untested;
- the Node it runs on: whether the ESM hook runs in-thread (`module.registerHooks`) or in Node's
  hooks worker, and on Node 20.9 / 20.10 that `--import tsx` runs after Hoplens (RAW, and the request
  path cannot read tsx's output there);
- a `.ts` entry under plain node: an error when the project's Node (volta, `.node-version`, `.nvmrc`,
  `engines.node`) or `--no-experimental-strip-types` cannot strip types, a warning when it cannot tell
  (22.18+ strips by default, 22.6+ with `--experimental-strip-types`);
- a CommonJS entry with exports run under `--import`, whose own functions are not wrapped (use `-r`);
- the transform cache's directory, its entry count and size, or that it is off;
- how to leave files out, and `HOPLENS_DEBUG=transform` for the per-file log.

Integrations lists OpenTelemetry packages, Zod (for the request builder) and `HOPLENS_PORT`. When
`HOPLENS_PORT` is unset doctor says the UI uses 4983, or the first free port up to 4993: the runtime
tries 4983 first, then the next 10 ports.

Example output on a healthy Express project, right after `init` answered yes:

![hoplens doctor on the Express example: Environment, Install, Wiring, Function hops, Integrations, All set](../../docs/images/terminal-doctor-express.png)

On a Next.js project the same run has no Function hops section:

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
  ✓ next.config.ts uses withHoplens, loaded by next dev only
  ✓ src/instrumentation.ts loads the Hoplens runtime
  • request path: off — enable it in the Path view (press x on a request) or with hoplens init --path

  Integrations
  • OpenTelemetry not detected — Hoplens runs standalone
  ✓ Zod ^4.6.7 — RequestBuilder will pre-fill from your schemas
  • HOPLENS_PORT not set — the UI uses 4983, or the first free port up to 4993

  All set.
```

### `hoplens remove`

Reverse of `init`. Gives the exported config in `next.config` back as it was, from the dev-only
function or from the pre-0.3 `withHoplens(...)` wrap (dropping the imports init added when nothing
else uses them), and
strips the Hoplens block from `instrumentation.register()`. Deletes files
that `init` created when nothing user-authored remains, so an
`init → remove` round-trip is byte-identical to the pre-init state.
It also deletes the data Hoplens wrote under the build output: the persisted
stats and the request path flag in `<distDir>/cache/hoplens` and
`<distDir>/cache/hoplens.json`.

```bash
npx hoplens remove             # undo init
npx hoplens remove --dry-run   # preview the undo without writing
```

On an Express project `remove` takes the flag `init` added out of the dev script (the script is
byte-identical to before `init`) and deletes `node_modules/.cache/hoplens` (persisted stats, source
manifest, transform cache and the request path flag). A flag in a `HOPLENS_OPTIONS` `stateDir`
elsewhere is deleted on its own.

Then `npm rm hoplens` to drop the dependency.
