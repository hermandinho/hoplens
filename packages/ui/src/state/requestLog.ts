import { batch, computed, effect, signal } from "@preact/signals";
import { api } from "../api/client";
import type { TraceSummary } from "../api/types";
import { clearedAt, liveActivity } from "./activity";
import { matchQuery, parseQuery, summaryTarget } from "./query";
import { serverLatencyByKey, serverStats } from "./serverStats";
import { type Percentiles, routeKeyOf } from "./stats";
import { clientRouteStats, loadTrace, mainView, setMainView, setSidebarTab, statsSource, tracesState } from "./store";
import { normalizeUrl } from "./traceview";

/*
 * The dense request log: one query (shared by the sidebar Traffic tab and the Requests view),
 * structural terms filtered client-side over the summaries, free text also sent to the server
 * (`?q=`, which searches logs and bodies too), and a keyboard cursor (j/k, Enter).
 */

export const logQuery = signal("");
export const parsedQuery = computed(() => parseQuery(logQuery.value));
/** Free-text terms need the server: the summaries only carry url, route and the error message. */
export const hasTextTerms = computed(() => parsedQuery.value.terms.some((t) => t.key === "text"));

export interface ServerSearch {
  q: string;
  ids: ReadonlySet<string>;
  errors: string[];
}
export const serverSearch = signal<ServerSearch | null>(null);
export const searchState = signal<"idle" | "searching" | "error">("idle");
export const searchError = signal<string | null>(null);

const SEARCH_DEBOUNCE_MS = 250;
/** Re-run a standing text search at most this often while traffic arrives. */
const SEARCH_REFRESH_MS = 1000;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;
let searchAbort: AbortController | null = null;
let lastSearched = "";
/** The query the pending `searchTimer` will run (debounce or refresh). */
let pendingQ = "";

async function runSearch(q: string): Promise<void> {
  const seq = ++searchSeq;
  searchAbort?.abort();
  const ctrl = typeof AbortController === "undefined" ? null : new AbortController();
  searchAbort = ctrl;
  lastSearched = q;
  searchState.value = "searching";
  try {
    const res = await api.searchTraces(q, ctrl ? { signal: ctrl.signal } : undefined);
    if (seq !== searchSeq) return;
    batch(() => {
      serverSearch.value = { q, ids: new Set(res.traces.map((t) => t.id)), errors: res.errors };
      searchState.value = "idle";
      searchError.value = null;
    });
  } catch (err) {
    if (seq !== searchSeq || (err as Error).name === "AbortError") return;
    batch(() => {
      searchState.value = "error";
      searchError.value = (err as Error).message;
    });
  }
}

function cancelSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  searchSeq++;
  searchAbort?.abort();
  searchAbort = null;
  lastSearched = "";
  pendingQ = "";
}

// Debounced while typing; throttled re-runs while traffic arrives (new traces may match).
effect(() => {
  const q = logQuery.value.trim();
  const text = hasTextTerms.value;
  liveActivity.value;
  if (!text) {
    cancelSearch();
    serverSearch.value = null;
    searchState.value = "idle";
    searchError.value = null;
    return;
  }
  if (q !== lastSearched) {
    // Only a change of query restarts the debounce. Live traffic re-runs this effect too, and
    // restarting on every arrival would starve the search under steady traffic.
    if (searchTimer && pendingQ === q) return;
    if (searchTimer) clearTimeout(searchTimer);
    pendingQ = q;
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
  } else if (!searchTimer || pendingQ !== q) {
    // Typed back to the query already searched: drop a debounce still pending for the other one.
    if (searchTimer) clearTimeout(searchTimer);
    pendingQ = q;
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch(logQuery.value.trim());
    }, SEARCH_REFRESH_MS);
  }
});
effect(() => {
  if (clearedAt.value === 0) return;
  serverSearch.value = null;
});

/**
 * The rows the log shows, newest first. A trace is in when the summary matches the whole query, or
 * (for free text) when the server matched it on logs or bodies. The server applies every term, so
 * its matches are always valid; the client match only fills in until the server answers.
 */
export const logRows = computed((): TraceSummary[] => {
  const pq = parsedQuery.value;
  const all = tracesState.value;
  if (pq.terms.length === 0) return all;
  const srv = hasTextTerms.value ? serverSearch.value : null;
  const ids = srv && srv.q === logQuery.value.trim() ? srv.ids : null;
  return all.filter((t) => matchQuery(pq, summaryTarget(t)) || (ids?.has(t.id) ?? false));
});

/** Problems with the query: the client's parse errors, plus any the server reported. */
export const queryErrors = computed(() => {
  const out = [...parsedQuery.value.errors];
  for (const e of serverSearch.value?.errors ?? []) if (!out.includes(e)) out.push(e);
  return out;
});

/* ----------------------------------------------- duration scale: the route's warm p95 */

/**
 * Lookup of a trace's route percentiles: the server's (survive eviction) when they are the active
 * source, else the client reduction. Server keys normalize id segments when there is no template.
 */
export const routeLatency = computed((): ((t: TraceSummary) => Percentiles | undefined) => {
  const s = serverStats.value;
  if (statsSource.value === "server" && s) {
    const m = serverLatencyByKey(s);
    return (t) => m.get(`${t.method} ${t.route ?? normalizeUrl(t.path)}`);
  }
  const m = new Map<string, Percentiles>();
  for (const r of clientRouteStats.value) m.set(r.key, r.latency);
  return (t) => m.get(routeKeyOf(t));
});

/* ------------------------------------------------------------- keyboard cursor */

/** The row j/k points at (not necessarily the open trace). */
export const logCursor = signal<string | null>(null);
// The cursor names a row of the current list: a new query or a Clear starts it over (a cursor left
// on a row that is no longer listed would leave no row in the Tab order).
effect(() => {
  logQuery.value;
  clearedAt.value;
  logCursor.value = null;
});

export function moveCursor(delta: number): void {
  const rows = logRows.value;
  if (rows.length === 0) return;
  const cur = logCursor.value;
  let i = cur ? rows.findIndex((t) => t.id === cur) : -1;
  if (i < 0) i = delta > 0 ? -1 : rows.length;
  const next = Math.min(rows.length - 1, Math.max(0, i + delta));
  logCursor.value = (rows[next] as TraceSummary).id;
}

export function openCursor(): boolean {
  const id = logCursor.value;
  if (!id || !logRows.value.some((t) => t.id === id)) return false;
  void loadTrace(id, "user");
  return true;
}

/** Is a request log on screen (the Requests view, or the sidebar's Traffic tab)? */
export function logVisible(sidebarTraffic: boolean): boolean {
  return mainView.value === "requests" || sidebarTraffic;
}

/* ------------------------------------------------------------------ query bar */

export const QUERY_INPUT_MAIN = "rlog-q-main";
export const QUERY_INPUT_SIDE = "rlog-q-side";

/** `/`: focus the visible query bar; outside the Requests view that's the sidebar's Traffic tab. */
export function focusQueryBar(): void {
  const id = mainView.value === "requests" ? QUERY_INPUT_MAIN : QUERY_INPUT_SIDE;
  if (id === QUERY_INPUT_SIDE) setSidebarTab("traffic");
  const focus = () => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.focus();
    el?.select();
  };
  if (document.getElementById(id)) focus();
  else requestAnimationFrame(focus);
}

/** Prefill the query (from a finding badge or a "Needs attention" row) and show the Requests view. */
export function prefillQuery(q: string): void {
  batch(() => {
    logQuery.value = q;
    logCursor.value = null;
  });
  setMainView("requests");
}
