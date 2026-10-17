---
"@hoplens/core": minor
"@hoplens/next": patch
---

Opt-in seams for framework adapters other than Next.js, so one can plug into the runtime without
importing core's AsyncLocalStorage or `@opentelemetry/api`:

- `HttpTap.describe(req, res)` names a finished request's route template and kind when no span
  carried `next.route`. The route is used as given (only Next's `/route` suffix is stripped) and
  still resolves its route file and handler line through discovery.
- `HttpTap.requestBody(req)` hands over a body the framework already parsed, for traces the Fetch
  `Request` hooks saw no body on. It is redacted and previewed like any captured JSON body.
- `Runtime.currentTrace()` and `Runtime.beginHop(kind, { name, file, line })` let an adapter
  annotate the current request and open its own hops; `end(err)` records a failure the way a
  throwing traced function does. `exit(fn)` runs work the hop hands off to (an Express `next()`) in
  the context the hop began in, so it lands as the hop's sibling.
- `RuntimeConfig.epochs: { mode: "none" }` never bumps the epoch on a rebuild, so each process is
  one epoch (with `persist`, a restart starts the next one), for frameworks with no build output:
  no build-output or source watchers, no chunk index. `"build"` stays the default.
- `options.stateDir` moves the `persist` files out of `<distDir>/cache/hoplens`.
- `RuntimeConfig.framework` is reported as `framework` by `/api/meta`. `@hoplens/next` now passes
  `{ name: "next", version }`; its other meta fields are unchanged.
- `Runtime.start()` no longer throws when the UI port is rejected synchronously (an out-of-range
  port): it logs and runs the banner as for a busy port. Once a runtime is stopped
  (`Runtime.isStopped`), its http hook passes every request through untouched.
- `@hoplens/next` marks its `next` peer optional, so installing `hoplens` for an Express app no
  longer pulls in Next.js and React.
