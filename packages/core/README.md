# @hoplens/core

Framework-agnostic runtime for [Hoplens](https://github.com/hermandinho/hoplens).
Captures HTTP requests via `http.Server.prototype.emit`, correlates spans with
`AsyncLocalStorage`, bridges to OpenTelemetry as a reader (never replaces an
existing provider), and serves the UI on a loopback port: 4983 by default
(`port` option or `HOPLENS_PORT`), or the first free one of the next 10 when it
is taken. The adapters also serve it at `/__hoplens` on your app's own port.

After each response it computes the request's facts (where the time went,
sizes, cold/compile) and findings (N+1, duplicates, parallelizable chains,
slow functions, uncached fetches, cold compiles, large payloads, swallowed
errors, logs on a success), off the request path. It keeps per-route stats,
query shapes, dev-rebuild edits with regression verdicts and process health,
and serves them as a loopback JSON API under `/__hoplens/api`. The options,
the query language and the endpoints are documented in the
[repo README](https://github.com/hermandinho/hoplens#readme).

## Subpaths

- `@hoplens/core/trace` — `traced()`, `step()` and `drizzleLogger()` for code
  the auto-tracer can't reach. No-ops when the runtime isn't loaded. From an
  app, import them as `hoplens/trace`: with pnpm, `@hoplens/core` is not
  resolvable from your project.
- `@hoplens/core/query` — the pure trace search grammar (`parseQuery`,
  `matchQuery`, `compileGlob`), shared with the UI.
- `@hoplens/core/coverage` — the request path's V8 block coverage on its own:
  `startCoverage()` starts precise coverage once per process (main thread only,
  never stopped; refused under `NODE_V8_COVERAGE`, state `disabled-c8`),
  `coverageHandle()` returns the running handle, `pathFlag()` reads
  `HOPLENS_PATH`. A separate entry so the Express register hook can start
  coverage before any app module loads without loading the rest of core.
  `@hoplens/next` starts it from the instrumentation hook.

## State dir

The adapters hand core a `stateDir` (absolute, or relative to the project
root): where `persist` writes its NDJSON, plus the source manifest and the
request path flag. Default `<distDir>/cache/hoplens` (`.next/cache/hoplens`);
`@hoplens/express` uses `node_modules/.cache/hoplens`. It is read from
`HOPLENS_OPTIONS` and from the options object, but it is not declared on the
`HoplensOptions` type.

## Epochs

Dev-rebuild epochs have three modes. `"build"` (the default, for `next dev`)
watches the build output and the source dirs. `"none"` never bumps, so each
process is one epoch. `"restart"` is for a server a watcher restarts on every save (`node --watch`,
`tsx watch`, nodemon; the Express adapter uses it): each start compares the
source files, token by token, with the `sources.manifest` the previous
process left in the state dir, and a restart that changed code opens a new
epoch. A `.json` that no module imports and that was written after the
previous start is not an edit, wherever it sits; `package.json`,
`tsconfig*.json` and `jsconfig*.json` always count. `"restart"` needs
`persist`.

## Request path API

Besides the trace, stats, queries, compare, epochs and health endpoints, under
`/__hoplens/api`:

| Endpoint | What it does |
|---|---|
| `POST /traces/:id/path` | Replays a GET or HEAD trace once, alone, as a new trace, and reports which blocks of your handler and function code ran. Errors are `{ code, error }`: 400 `method`, 404 `not-found`, 409 `busy` / `not-quiet` / `path-off`, 500 `take-failed`, 502 `replay-failed`. |
| `GET /traces/:id/path` | The path payload of a path trace. 404 `no-path` / `superseded`, 410 `evicted` (the last 20 are kept). |
| `POST /path/enable`, `POST /path/disable` | The sticky switch: writes or removes `<stateDir>/path.json`, applied at the next start. Callers on this machine only, even with `allowRemote` (403 `forbidden`); 409 `env` while `HOPLENS_PATH` is set, 409 `unsupported` for an adapter with no switch. |
| `GET /traces/:id/request` | The request as it can be resent: method, URL, headers, raw body. |
| `GET /source?file=&line=&context=` | `context` lines (default 10) around `line`, plus `hash`, the file's sha1/12 that a path trace records per function. |
| `GET /queries?limit=` | Cross-request query shapes, at most `limit`. |
| `GET /routes?fresh` | The route list; `fresh` scans again instead of answering from the last scan. |

`GET /meta` reports `path.source` (`env`, `flag` or `default`) and
`path.pending` after a toggle that waits for the restart.

## API guard

Every UI and API request goes through one guard before routing
(`src/api/guard.ts`): the client address must be loopback, the `Host` (and an
`x-forwarded-host`) must name this machine, which stops DNS rebinding, a
present `Origin` must be loopback, and a state-changing request from a browser
must send `content-type: application/json` (text/plain, form and multipart
bodies get 415). `allowRemote: true` drops the address and Host checks; the
Origin (loopback or same host) and content-type rules stay.

Internal — pulled in by adapters like
[`@hoplens/next`](https://www.npmjs.com/package/@hoplens/next) and
[`@hoplens/express`](https://www.npmjs.com/package/@hoplens/express). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) instead.
