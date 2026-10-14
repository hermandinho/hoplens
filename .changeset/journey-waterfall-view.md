---
"hoplens": patch
"@hoplens/ui": patch
---

Add a classic trace-waterfall view for Journey, now the default. The
original horizontal-flow SVG view is kept behind a **Flow / Waterfall**
toggle in the Journey header — pick whichever reads better for your
trace, your choice persists in localStorage.

The waterfall renders one row per span, indented by depth in the
parent-child tree, with a time-proportional bar on the right (Jaeger /
Chrome DevTools pattern). Labels live in a fixed-width left column so
they no longer overlap when traces get busy.
