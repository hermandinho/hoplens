---
"@hoplens/ui": minor
---

The Path tab works for Next apps: no more "Express only for now"; the Enable / Disable switch shows
for Next too, and its notes say "Restart next dev to apply" (a save hot-reloads there, it does not
restart). UNKNOWN `stale-chunk` explains that the bundler rewrote the file's chunk after it loaded
(restart next dev, or set HOPLENS_PATH_DEBUGGER=1).
