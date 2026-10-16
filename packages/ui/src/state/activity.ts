import { signal } from "@preact/signals";

/*
 * A tiny bus for "the retained traces changed on the server": bumped by the store on every live
 * `done`, `update` and `clear` event and on bootstrap. Modules that cache server aggregates
 * (/api/stats, /api/queries) subscribe to it instead of importing the store, which keeps the
 * import graph acyclic (the store reads their signals).
 */
export const liveActivity = signal(0);
/** Bumped on `clear` only, so caches can drop their data at once instead of waiting for a refetch. */
export const clearedAt = signal(0);

export function noteActivity(kind: "done" | "update" | "clear" | "bootstrap"): void {
  if (kind === "clear") clearedAt.value++;
  liveActivity.value++;
}

/**
 * Leading + trailing throttle: the first call runs at once, calls inside the window collapse into
 * one trailing run at its end, so the last change always lands.
 */
export function throttle(fn: () => void, ms: number): { (): void; cancel(): void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  const call = () => {
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return call;
}
