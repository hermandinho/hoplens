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

/* ------------------------------------------------ highlight + zoom (contract 4.1) */

/**
 * Spans to emphasise on the canvas (flame and tree). Non-matching spans are dimmed, never hidden.
 * `reason` names why ("finding:nplus1", "search:getUser") for the canvas legend / aria-live text.
 * Written by the verdict, "where to look" and span search; read by the canvas (WP3).
 */
export interface CanvasHighlight {
  spanIds: ReadonlySet<string>;
  reason: string;
}

export const highlight = signal<CanvasHighlight | null>(null);

export function setHighlight(spanIds: Iterable<string>, reason: string): void {
  highlight.value = { spanIds: new Set(spanIds), reason };
}

export function clearHighlight(): void {
  highlight.value = null;
}

/**
 * Zoom target: a span id, "handler" (the route handler span, skipping the pre-handler wait), or
 * null for the full range. `seq` increments on every call so re-zooming to the same target is still
 * a change the canvas sees.
 */
export type ZoomTarget = string | "handler" | null;

export const zoomRequest = signal<{ target: ZoomTarget; seq: number }>({ target: null, seq: 0 });

/** Ask the canvas to zoom. The canvas (WP3) consumes `zoomRequest` and owns the actual viewport. */
export function zoomTo(target: ZoomTarget): void {
  zoomRequest.value = { target, seq: zoomRequest.value.seq + 1 };
}

/* ------------------------------------------------------------ viewport (WP3) */

/**
 * The canvas viewport for one trace, in trace ms. `range` absent = the full range. No entry for the
 * shown trace = its default view: zoomed to the handler when the trace is cold, else the full range.
 * Written by the canvas (zoom keys, minimap brush, zoomRequest); read by the canvas and minimap.
 */
export interface CanvasViewport {
  traceId: string;
  range?: [number, number];
}

export const viewport = signal<CanvasViewport | null>(null);

export function setViewport(traceId: string, range?: [number, number]): void {
  viewport.value = range ? { traceId, range } : { traceId };
}
