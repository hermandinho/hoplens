---
"@hoplens/core": patch
---

`Runtime.routeInfo()` picks, among discovery entries that share a template, the one that declares
the request's method, and ignores entries with no source file instead of giving the trace an empty
route file and handler location.
