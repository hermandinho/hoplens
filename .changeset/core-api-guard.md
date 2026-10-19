---
"@hoplens/core": patch
"@hoplens/ui": patch
---

Security: one guard now fronts every `/__hoplens` route (the UI page, the API, the SSE streams), not just the request path switch. The `Host` and any `x-forwarded-host` must name this machine (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`, any port), which stops DNS rebinding; a browser's `Origin` must be local too (any port, so the Vite dev proxy and the app-port mount keep working). Refusals are 403 `{ code: "forbidden" }` and say where to open Hoplens. `POST` and `DELETE` from a browser must send `content-type: application/json`, and text/plain, form and multipart bodies are refused (415 `{ code: "content-type" }`): a cross-site page can no longer replay requests through `POST /api/run` with a simple request. Scripts that post JSON without the header need to add it. `allowRemote: true` keeps serving any client and Host (rebinding protection is off there; the Origin and content-type checks stay), and the request path switch still answers this machine only. The UI sends the JSON content type on its writes.
