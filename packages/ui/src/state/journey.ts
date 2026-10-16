import { batch, computed, effect, signal } from "@preact/signals";
import { clearHighlight as clearCanvasHighlight, highlight, setHighlight, viewport } from "./canvas";
import { selectedTrace } from "./store";

/*
 * Selection state for the single-request view: the hop shown in the Inspector, and the spans a
 * finding chip asked the canvas to highlight and scroll to. The highlight itself lives in
 * state/canvas.ts (contract 4.1); the helpers here are the older entry points, kept as thin wrappers.
 */

export const selectedHopId = signal<string | null>(null);

/** Span ids highlighted on the canvas. Empty = nothing highlighted. Derived from canvas `highlight`. */
export const highlightedSpanIds = computed<ReadonlySet<string>>(() => highlight.value?.spanIds ?? new Set());
/** Bumped on every highlightSpans() call so the canvas scrolls even when the set is unchanged. */
export const highlightNonce = signal(0);

export function selectHop(id: string | null): void {
  selectedHopId.value = id;
}

/** Highlight `ids` on the canvas, select the first one and scroll it into view. */
export function highlightSpans(ids: readonly string[], reason = "finding"): void {
  batch(() => {
    setHighlight(ids, reason);
    highlightNonce.value++;
    if (ids[0]) selectedHopId.value = ids[0];
  });
}

export function clearHighlight(): void {
  if (highlight.value) clearCanvasHighlight();
}

// A different trace (click, Follow, deep link) starts with a clean selection, no highlight and its
// default zoom.
let lastTraceId: string | null = null;
effect(() => {
  const id = selectedTrace.value?.id ?? null;
  if (id === lastTraceId) return;
  lastTraceId = id;
  batch(() => {
    selectedHopId.value = null;
    clearCanvasHighlight();
    if (viewport.peek() && viewport.peek()?.traceId !== id) viewport.value = null;
  });
});
