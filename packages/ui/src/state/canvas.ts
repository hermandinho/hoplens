import { signal } from "@preact/signals";

/*
 * View preferences for the single-request canvas: Flame or Tree, and whether the critical path is
 * outlined. Remembered per browser (localStorage, best effort).
 */

export type CanvasMode = "tree" | "flame";

const MODE_KEY = "hoplens.canvas.mode";
const CRIT_KEY = "hoplens.canvas.critical";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: keep the in-memory value */
  }
}

export const canvasMode = signal<CanvasMode>(read(MODE_KEY) === "flame" ? "flame" : "tree");
export const showCritical = signal(read(CRIT_KEY) !== "0");

export function setCanvasMode(m: CanvasMode): void {
  canvasMode.value = m;
  write(MODE_KEY, m);
}

export function toggleCritical(): void {
  showCritical.value = !showCritical.value;
  write(CRIT_KEY, showCritical.value ? "1" : "0");
}
