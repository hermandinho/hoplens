---
"@hoplens/ui": patch
"@hoplens/core": patch
---

The request builder opens the route entry that declares the request's method when several entries
share one template (an Express route registered in two files, or GET and POST on separate lines),
falling back to one that accepts any method. A `route:/` filter now matches only `/` instead of every
route.
