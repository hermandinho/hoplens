---
"@hoplens/core": patch
"@hoplens/ui": patch
---

A response body over the 512KB capture limit keeps its first 512KB even when it is written in one
chunk (`res.json()` of a large export, `NextResponse.json` of a big list). Before, a single chunk past
the limit was dropped whole, so the Response tab said "truncated" over an empty body. The label now
says how much is shown ("truncated: first 20KB of 2.0MB shown").
