import { computed, effect, signal } from "@preact/signals";
import { api } from "../api/client";
import { selectedHopId } from "./journey";
import { selectedTrace } from "./store";

/** "span" is the selected span's details (Inspector's SpanDetail), shown while a span is selected. */
export type DetailsTab = "response" | "console" | "request" | "span";

export const detailsTab = signal<DetailsTab>("response");

export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export const rawRequest = signal<RawRequest | null>(null);
export const rawRequestError = signal<string | null>(null);

/** Count badges per tab, so the user can see at a glance if there's anything to look at. */
export const detailsCounts = computed(() => {
  const t = selectedTrace.value;
  if (!t) return { response: 0, console: 0, request: 0, span: 0 };
  return { response: t.response.body ? 1 : 0, console: t.logs.length, request: 1, span: 0 };
});

// Picking a span (canvas, Where to look, n/N) shows its details: the drawer switches to Span. When
// the selection clears, the tab falls back to Response (Details renders that while no span exists).
let lastHop: string | null = null;
effect(() => {
  const hop = selectedHopId.value;
  if (hop && hop !== lastHop) detailsTab.value = "span";
  else if (!hop && detailsTab.peek() === "span") detailsTab.value = "response";
  lastHop = hop;
});

export function setDetailsTab(tab: DetailsTab): void {
  detailsTab.value = tab;
}

// Fetch the raw replay-ready request only when the Request tab becomes active and we have a trace.
// Debounced via "last fetched traceId" so switching tabs doesn't refetch unless the trace changed.
let lastFetchedId: string | null = null;
effect(() => {
  const t = selectedTrace.value;
  const tab = detailsTab.value;
  if (!t || tab !== "request") return;
  if (lastFetchedId === t.id) return;
  lastFetchedId = t.id;
  const id = t.id;
  // Never show the previous trace's request while this one loads (or after it fails).
  rawRequest.value = null;
  rawRequestError.value = null;
  api
    .rawRequest(id)
    .then((req) => {
      if (selectedTrace.value?.id !== id) return;
      rawRequest.value = req;
    })
    .catch((err) => {
      if (selectedTrace.value?.id !== id) return;
      rawRequest.value = null;
      rawRequestError.value = (err as Error).message;
    });
});
