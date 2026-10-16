import { batch, effect, signal } from "@preact/signals";
import { selectedTrace } from "./store";

/*
 * Selection state for the single-request view: the hop shown in the Inspector, and the spans a
 * finding chip asked the waterfall to highlight and scroll to.
 */

export const selectedHopId = signal<string | null>(null);

/** Span ids highlighted in the waterfall (from a finding chip). Empty = nothing highlighted. */
export const highlightedSpanIds = signal<ReadonlySet<string>>(new Set());
/** Bumped on every highlight request so the waterfall scrolls even when the set is unchanged. */
export const highlightNonce = signal(0);

export function selectHop(id: string | null): void {
  selectedHopId.value = id;
}

/** Highlight `ids` in the waterfall, select the first one and scroll it into view. */
export function highlightSpans(ids: readonly string[]): void {
  batch(() => {
    highlightedSpanIds.value = new Set(ids);
    highlightNonce.value++;
    if (ids[0]) selectedHopId.value = ids[0];
  });
}

export function clearHighlight(): void {
  if (highlightedSpanIds.value.size > 0) highlightedSpanIds.value = new Set();
}

// A different trace (click, Follow, deep link) starts with a clean selection.
let lastTraceId: string | null = null;
effect(() => {
  const id = selectedTrace.value?.id ?? null;
  if (id === lastTraceId) return;
  lastTraceId = id;
  batch(() => {
    selectedHopId.value = null;
    highlightedSpanIds.value = new Set();
  });
});
