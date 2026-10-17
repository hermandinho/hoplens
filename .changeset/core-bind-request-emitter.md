---
"@hoplens/core": minor
---

`HttpTap` takes an opt-in `bindRequestEmitter` flag. When an adapter sets it, every event the incoming
request emits (`data`, `end`, ...) runs inside that request's trace, so a handler that continues from
`end`, as Express does behind `express.json()`, keeps its hops and route, and spans started there
nest under the last hop the adapter entered with `beginHop().run()` instead of losing their parent. Before, Node dropped the
context after the first body chunk and a POST with a body that arrived over several ticks recorded
nothing past the parser. Off by default: Next.js capture is unchanged.
