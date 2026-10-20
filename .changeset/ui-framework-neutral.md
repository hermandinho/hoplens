---
"@hoplens/ui": minor
---

Framework-neutral copy, and request builder fixes for Express:

- The top bar shows the host framework from `/api/meta` (`Express 5.3.0`), falling back to the
  older `next` field. Outside Next.js the UI no longer talks about `next dev`, dev compiles,
  `instrumentation.ts`, `withHoplens` or Next's data cache: the framework band, time-budget hints,
  verdict, cold tags and the `cold-compile` label ("cold start") say "first request after
  start/restart" instead. Next.js copy is unchanged.
- A live-stream reconnect re-reads meta and routes as well as the traces. Outside Next.js a restart
  (node --watch) that dropped old requests is an "App restarted" info note, not an error.
- Request builder: path params start empty (the chip shows the name), never seeded with their own
  name; Send waits for required params. A param inside a segment (`/report.:format*`) gets its own
  chip, and an empty optional one drops the `.` before it. The route picker shows the template
  traces use (Next keeps its `:param` path), appends the file when one method + template is
  registered in two files, and lists regex routes last, disabled with a reason; a regex route
  opened from a trace can't be sent either. An empty `*` param that fills a whole segment drops its
  `/` too.
- The vitest export, query suggestions and Changes copy name the framework's own dev loop.
- A reconnect resync keeps requests that arrived live while it was fetching instead of counting them
  as lost.
- The builder drawer no longer doubles its chrome: there is one "New request" header and one close,
  and it stays in view. With only the builder open the drawer's head is pinned and carries it; over a
  request or a compare the pinned bar's close closes the builder first, as Esc does.
- Edits found across restarts (`via: "restart"`) count as edits of the dev loop in Changes even
  though each comes from a new process, are not greyed as earlier-session edits, and read "saved, app
  restarted". Outside Next.js the empty Changes view says "Save a file: node --watch restarts the app
  and the edit shows up here", and the epoch wording follows: a new epoch when a restart changed code.
