# @hoplens/core

Framework-agnostic runtime for [Hoplens](https://hoplens.dev). Captures HTTP requests via `http.Server.prototype.emit`, correlates spans with `AsyncLocalStorage`, bridges to OpenTelemetry, serves the UI on a loopback port.

Not meant to be installed directly — pulled in by an adapter such as `@hoplens/next`.
