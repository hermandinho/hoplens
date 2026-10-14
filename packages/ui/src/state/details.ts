import { computed, effect, signal } from "@preact/signals";
import { api } from "../api/client";
import { selectedTrace } from "./store";

export type DetailsTab = "response" | "waterfall" | "console" | "request";

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
  if (!t) return { response: 0, waterfall: 0, console: 0, request: 0 };
  return {
    response: t.response.body ? 1 : 0,
    waterfall: t.spans.length,
    console: t.logs.length,
    request: 1,
  };
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
  rawRequestError.value = null;
  api
    .rawRequest(t.id)
    .then((req) => {
      rawRequest.value = req;
    })
    .catch((err) => {
      rawRequest.value = null;
      rawRequestError.value = (err as Error).message;
    });
});
