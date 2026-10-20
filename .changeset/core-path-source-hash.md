---
"@hoplens/core": patch
---

Request path: `GET /api/source` also returns `hash`, the sha1/12 of the whole file as it is now (the
same hash a path trace records per function), so the UI can tell when a file changed after its
trace. Graph nodes carry `ambiguous`: the calls left unlinked because more than one recorded hop of
the function matches the name.
