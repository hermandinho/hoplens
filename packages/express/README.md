# @hoplens/express

[![npm](https://img.shields.io/npm/v/@hoplens/express.svg)](https://www.npmjs.com/package/@hoplens/express)

Express 4 and 5 adapter for [Hoplens](https://github.com/hermandinho/hoplens): a request-journey
view at `/__hoplens` on your app's own port while you develop.

> **Early preview.** Requests, request bodies (redacted) and static assets are captured today.
> Route templates and middleware/handler hops come next.

Most users install the meta-package and use its `hoplens/express` entries (pnpm does not hoist
`@hoplens/express` for you):

```bash
npm i -D hoplens
```

## Usage

Preload the register hook. It works with both flags, for CommonJS and ESM apps:

```bash
node -r hoplens/express/register server.js
node --import hoplens/express/register server.mjs
```

Or start it from code:

```js
const express = require("express");
const { hoplens } = require("hoplens/express");

const app = express();
hoplens(app);
```

Call it before `app.listen()`: Hoplens then starts right before your server binds, as the register
hook does. Called later, it starts about 3 seconds after the call.

Then open `http://localhost:<your port>/__hoplens` (also served standalone on
`http://127.0.0.1:4983`).

## When it runs

- On when `NODE_ENV` is unset or `development`.
- Off for `NODE_ENV=production` or `test`, unless `HOPLENS_FORCE=1`.
- Off for `HOPLENS=0`.

With the gate off, the register hook patches nothing and never loads `@hoplens/core`. With it on, the
runtime starts right before your app's first `listen()`; a script that never listens binds no port.

## Options

`hoplens(app, options)` takes the shared `HoplensOptions` (`port`, `redact`, `maxTraces`, `insights`,
`persist`, ...). From the environment:

| Variable | Effect |
|---|---|
| `HOPLENS_PORT` | Standalone UI port (default 4983) |
| `HOPLENS_OPTIONS` | JSON `HoplensOptions`, applied before code options |
| `HOPLENS_IGNORE` | Comma-separated path prefixes never traced, e.g. `/health,/metrics` |

`persist` is on by default here and writes route stats to `node_modules/.cache/hoplens`.
