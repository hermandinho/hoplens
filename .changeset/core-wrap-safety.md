---
"@hoplens/core": patch
---

Traced functions behave like the originals inside a request. Argument and result previews never run
app code or throw: a Proxy shows as `[Proxy]`, an accessor as `[Getter]`, anything unreadable as
`[unreadable]`. A promise the function decorated (`p.cancel = ...`, a subclass) comes back as the same
object. A trace records at most 1000 function spans; later calls run unwrapped and count in
`droppedSpans`.
