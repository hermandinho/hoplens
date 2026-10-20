---
"@hoplens/next": minor
"hoplens": minor
---

Request path for Next dev (Turbopack and `--webpack`). With `HOPLENS_PATH=1`, or the sticky switch
(the Path view's Enable button, `hoplens init --path`: `.next/cache/hoplens/path.json`, or
withHoplens' `stateDir`), the instrumentation hook starts V8 block coverage first thing, before the
first request's proxy and route code, and Trace path replays a GET once and shows which branches of
your route and lib functions ran. Nothing of the inspector loads while it is off; NODE_V8_COVERAGE
(c8) keeps it disabled; HOPLENS_PATH always wins over the switch, which applies at the next start
of `next dev`. Coverage runs from that start, so CPU-heavy code runs slower. The banner says when it
is on.
