# @hoplens/core

Framework-agnostic runtime for [Hoplens](https://github.com/hermandinho/hoplens).
Captures HTTP requests via `http.Server.prototype.emit`, correlates spans with
`AsyncLocalStorage`, bridges to OpenTelemetry as a reader (never replaces an
existing provider), and serves the UI on a free loopback port.

Internal — pulled in by adapters like
[`@hoplens/next`](https://www.npmjs.com/package/@hoplens/next). You almost
certainly want [`hoplens`](https://www.npmjs.com/package/hoplens) instead.
