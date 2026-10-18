---
"@hoplens/cli": minor
"hoplens": minor
---

`hoplens init`, `doctor` and `remove` support Express projects. The framework is detected from
package.json (`next` or `express`); a project with both needs `--framework next|express`, which all
three commands now take.

- `init` adds `--import hoplens/express/register` to `scripts.dev` (else `start:dev`, else `watch`)
  and changes no other byte of package.json (indentation, key order, CRLF, trailing newline). It
  wires `node [--watch]`, `tsx [watch]` and `nodemon` (as `--exec "node --import ..."`, or inside an
  existing `--exec "node ..."`), keeping env prefixes such as `cross-env NODE_ENV=development` and
  `&&` chains: only the command that starts the app gets the flag. Other runners (`ts-node-dev`,
  `ts-node`, `pm2`, `bun`, `docker`) are left alone with the line to use printed, and with no dev
  script it prints the one to add. `scripts.start` and the entry file are never edited. A second
  run reports "already wired". `--dry-run` shows a `-`/`+` preview; the install hint and next steps
  use the project's package manager and, when it can tell, the app's port.
- `doctor` checks that `hoplens` is resolvable from the project (not through `NODE_PATH`; with pnpm
  the `hoplens/express/register` form is recommended), that Express is 4 or 5, and that the dev
  script loads the hook. The hook in `scripts.start` or a production-looking script is critical;
  `NODE_OPTIONS` carrying it (scripts or `.env*`) and `NODE_ENV=production` in the dev script warn;
  a `hoplens(app)` call in the entry file is noted. Same output and exit codes as the Next checks.
- `remove` takes out exactly what `init` added, so the dev script is byte-identical to before, and
  deletes `node_modules/.cache/hoplens`. The dependency stays, as for Next.
