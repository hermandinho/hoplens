---
"@hoplens/core": patch
---

A file saved right after the source watcher started is no longer lost: the startup pre-hash read the
new bytes and kept them as the baseline, so the save's own change event looked like a same-bytes
save and was dropped (29 of 30 rapid saves after start went missing). Files modified within 100ms of
the watcher starting, or later, are left out of the baseline.
