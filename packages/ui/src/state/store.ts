import { batch, computed, effect, signal } from "@preact/signals";
import { HoplensApiError, type LiveConnection, api, openLive } from "../api/client";
import type { Discovery, Meta, RouteInfo, TraceRecord, TraceSummary } from "../api/types";
import { noteActivity } from "./activity";
import { type Route, go, initRouter, route } from "./router";
import { mergeFindingGroups, serverKpis, serverRouteBadges, serverRouteStats, serverStats } from "./serverStats";
import {
  type FindingGroup,
  computeKpis,
  computeRouteStats,
  groupFindings,
  isCountable,
  isError,
  markGone,
  newestEpochByRoute,
  routeBadges,
} from "./stats";

type LoadState = "idle" | "loading" | "ready" | "error";
/**
 * The four top-bar tabs (plan 3.8), derived from the router: the URL hash is the source of truth.
 * "requests" covers the log, a trace subject (#/r/<id>) and compare (#/cmp/a..b).
 */
export type MainView = "overview" | "requests" | "queries" | "changes";

export const metaState = signal<Meta | null>(null);
export const routesState = signal<Discovery | null>(null);
export const tracesState = signal<TraceSummary[]>([]);
export const selectedTraceId = signal<string | null>(null);
export const selectedTrace = signal<TraceRecord | null>(null);
export const followLive = signal(true);
export const liveStatus = signal<"live" | "reconnecting" | "offline">("offline");
/** Connectivity / bootstrap failure. Shown as "Can't reach Hoplens" only while loadStatus is "error". */
export const loadError = signal<string | null>(null);
/** A failed user action (Clear, opening a trace). Transient: cleared by the next success. */
export const actionError = signal<string | null>(null);
export const loadStatus = signal<LoadState>("idle");

/** "routeId::METHOD" — identifies which route+method pair the request builder is editing. */
export const selectedRouteKey = signal<string | null>(null);

/** The active tab, derived from the route (read-only; navigate with setMainView or router.go). */
export const mainView = computed<MainView>(() => viewOfRoute(route.value));

export function viewOfRoute(r: Route): MainView {
  switch (r.view) {
    case "overview":
    case "queries":
    case "changes":
      return r.view;
    default:
      return "requests";
  }
}

/**
 * Hold the live list still (plan 3.8 "Live list"): true while the pointer is over the request list
 * or focus is inside the subject pane. Follow doesn't move the selection while held; the newest
 * arrival is applied when the hold ends.
 */
export const liveHold = signal(false);
/** Percentiles exclude cold (first-after-rebuild / compiling) requests unless this is on. */
export const includeCold = signal(false);
export const clearing = signal(false);
/** The request builder lives in a drawer above the trace; a route click or "New request" opens it. */
export const builderOpen = signal(false);

/* ------------------------------------------------- cross-request stats (Overview, badges) */

/**
 * Finished, non-asset traces: the only ones the stats count. Keeps the previous array when the set
 * is unchanged, so a `start` event (or a re-sent summary) doesn't re-run every stat below.
 */
let lastFinished: TraceSummary[] = [];
export const finishedTraces = computed(() => {
  const next = tracesState.value.filter(isCountable);
  const same = next.length === lastFinished.length && next.every((t, i) => t === lastFinished[i]);
  if (!same) lastFinished = next;
  return lastFinished;
});

export const findingGroups = computed(() => groupFindings(finishedTraces.value));
/** Client-side reduction over the retained summaries (what the tab still holds). */
export const clientRouteStats = computed(() => computeRouteStats(finishedTraces.value, includeCold.value));

/**
 * Where the percentiles and counts come from. "server" = GET /api/stats: survives ring eviction,
 * always excludes cold requests. "client" = the retained summaries in this tab: used when the
 * endpoint is unavailable, and whenever "Include cold" is on (the server can't add cold back).
 */
export const statsSource = computed<"server" | "client">(() =>
  !includeCold.value && serverStats.value ? "server" : "client",
);

export const routeStats = computed(() => {
  const s = serverStats.value;
  if (statsSource.value !== "server" || !s) return clientRouteStats.value;
  const last = new Map<string, string>();
  for (const r of clientRouteStats.value) last.set(r.key, r.lastTraceId);
  return serverRouteStats(s, last);
});
/** Retained trace ids, for "open example" on server-only rows (findings, route exemplars). */
export const retainedIds = computed(() => new Set(tracesState.value.map((t) => t.id)));

/**
 * The ranked findings (plan 3.7: one ranking for the Overview, its hero and the palette): the server
 * rollup (survives eviction) joined with this tab's groups, ordered by `rankFindingGroups`.
 */
export const overviewFindings = computed<FindingGroup[]>(() => {
  const server = statsSource.value === "server" ? serverStats.value?.findings : undefined;
  const ids = retainedIds.value;
  const merged = mergeFindingGroups(findingGroups.value, server, (id) => ids.has(id));
  const s = statsSource.value === "server" ? serverStats.value : undefined;
  return markGone(merged, newestEpochByRoute(finishedTraces.value, s?.routes));
});
export const kpis = computed(() => {
  const s = serverStats.value;
  const groups = findingGroups.value;
  if (statsSource.value === "server" && s) return serverKpis(s, groups.length, groups.filter((g) => g.isNew).length);
  return computeKpis(finishedTraces.value, includeCold.value, groups);
});
/** Keyed by route template (`route ?? path`), all methods together. */
export const routeBadgeMap = computed(() => {
  const s = serverStats.value;
  if (statsSource.value === "server" && s) return serverRouteBadges(s);
  return routeBadges(finishedTraces.value, includeCold.value);
});
export const hasRoutes = computed(() => (routesState.value?.routes.length ?? 0) > 0);
export const hasTraces = computed(() => tracesState.value.length > 0);
/** Same definition as the Overview's Errors KPI (stats.isError: 5xx), so the counts agree. */
export const tracesWithErrors = computed(() => tracesState.value.filter(isError).length);

/** Point the request builder at one route + method and open it in the Requests subject. */
export function selectRoute(r: RouteInfo, method: string): void {
  batch(() => {
    selectedRouteKey.value = `${r.id}::${method}`;
    builderOpen.value = true;
  });
  showRequestsSubject();
}

/**
 * Open the builder drawer. With no route picked yet, pre-select the one the given request hit
 * (matched by route template and method) so "New request" from a trace starts somewhere useful.
 */
export function openBuilder(from?: { method: string; route?: string; path: string }): void {
  batch(() => {
    if (!selectedRouteKey.value && from) {
      const tpl = from.route ?? from.path;
      const found = routesState.value?.routes.find((r) => r.nextRoute === tpl || r.path === tpl);
      const m = found?.methods.find((x) => x.method === from.method) ?? found?.methods.find((x) => x.method === "ANY");
      if (found && m) selectedRouteKey.value = `${found.id}::${m.method}`;
    }
    builderOpen.value = true;
  });
  showRequestsSubject();
}

/** The builder drawer lives in the Requests subject: switch there, keeping the open trace if any. */
function showRequestsSubject(): void {
  if (mainView.value !== "requests") setMainView("requests");
}

export function closeBuilder(): void {
  builderOpen.value = false;
}

/**
 * Switch tabs (pushes history). Requests reopens the selected request as its subject, so going
 * Overview -> Requests doesn't lose your place. The since scope carries over.
 */
export function setMainView(v: MainView): void {
  const since = route.value.since;
  const id = selectedTraceId.value;
  let next: Route;
  if (v === "requests")
    next = id && tracesState.value.some((t) => t.id === id) ? { view: "trace", traceId: id } : { view: "requests" };
  else next = { view: v };
  go(since ? { ...next, since } : next);
}

/** The Requests tab without a subject, keeping the since scope. */
function requestsRoute(): Route {
  const since = route.value.since;
  return since ? { view: "requests", since } : { view: "requests" };
}

/** Close the Requests subject (the selection stays highlighted in the list). */
export function closeSubject(): void {
  builderOpen.value = false;
  const v = route.value.view;
  if (v === "trace" || v === "compare") go(requestsRoute());
}

export function toggleIncludeCold(): void {
  includeCold.value = !includeCold.value;
}

/** Fetch meta + routes + traces in parallel. Called on mount and when the user explicitly refreshes. */
export async function bootstrap(): Promise<void> {
  loadStatus.value = "loading";
  loadError.value = null;
  try {
    const [meta, routes, traces] = await Promise.all([api.meta(), api.routes(), api.traces()]);
    batch(() => {
      metaState.value = meta;
      routesState.value = routes;
      tracesState.value = traces;
      loadStatus.value = "ready";
    });
    noteActivity("bootstrap");
  } catch (err) {
    loadError.value = (err as Error).message;
    loadStatus.value = "error";
  }
}

export type SelectSource = "user" | "follow" | "hash";

/**
 * Load one trace's full detail (hops, logs, bodies) and make it the selection. A finished trace
 * that is already loaded is not fetched again; an in-flight one is (to complete it). `source` says
 * who asked:
 *  - "user": a click (log row, finding, route table). Opens it as the Requests subject (pushes
 *    history, so Back returns; `replace` for j/k stepping) and turns Follow off: what you picked
 *    stays put under live traffic.
 *  - "hash": the route already names it (deep link, Back/Forward). Pauses Follow unless it is the
 *    newest trace, so the next arrival doesn't replace the linked one.
 *  - "follow": a live arrival. Replaces the subject (no history entry) only while the Requests tab
 *    shows; elsewhere it only records the id, and switching to Requests opens it.
 */
export async function loadTrace(
  id: string,
  source: SelectSource = "user",
  opts: { replace?: boolean } = {},
): Promise<void> {
  const r = route.value;
  batch(() => {
    if (source === "user") followLive.value = false;
    else if (source === "hash" && followLive.value && newestFinishedId() !== id) followLive.value = false;
    selectedTraceId.value = id;
  });
  const traceRoute: Route = r.since ? { view: "trace", traceId: id, since: r.since } : { view: "trace", traceId: id };
  if (source === "user") go(r.view === "trace" && r.traceId === id ? r : traceRoute, { replace: opts.replace });
  else if (source === "follow" && (r.view === "requests" || r.view === "trace")) go(traceRoute, { replace: true });
  // Only the trace subject shows the full record; opening it (the route effect) fetches it.
  if (route.value.view === "trace") await fetchSelected(id);
}

/** The id whose GET is in flight: a click and the route effect it triggers share one fetch. */
let fetching: string | null = null;

async function fetchSelected(id: string): Promise<void> {
  const cur = selectedTrace.value;
  if ((cur?.id === id && cur.done) || fetching === id) return;
  fetching = id;
  try {
    const t = await api.trace(id);
    // A newer selection may have landed while this one was in flight (Follow under load).
    if (selectedTraceId.value !== id) return;
    batch(() => {
      selectedTrace.value = t;
      actionError.value = null;
    });
  } catch (err) {
    if (selectedTraceId.value !== id) return;
    if (err instanceof HoplensApiError && err.status === 404) {
      // Evicted from the ring buffer, or a stale deep link: drop it quietly.
      clearSelection();
      return;
    }
    actionError.value = `Could not load the trace: ${(err as Error).message}`;
  } finally {
    if (fetching === id) fetching = null;
  }
}

/**
 * Follow under a burst: coalesce arrivals so only the newest one is fetched, at most once per
 * FOLLOW_DEBOUNCE_MS, instead of one full-trace GET per finished request.
 */
const FOLLOW_DEBOUNCE_MS = 100;
let pendingFollow: string | null = null;
let followTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFollow(id: string): void {
  pendingFollow = id;
  if (followTimer) return;
  followTimer = setTimeout(() => {
    followTimer = null;
    const next = pendingFollow;
    pendingFollow = null;
    // Held (pointer on the list, focus in the subject): leave the selection alone. Releasing the
    // hold applies the newest arrival (initRouting).
    if (next && followLive.value && !liveHold.value) void loadTrace(next, "follow");
  }, FOLLOW_DEBOUNCE_MS);
}

function newestFinishedId(): string | undefined {
  return tracesState.value.find((t) => t.done && t.kind !== "asset")?.id;
}

export function clearSelection(): void {
  batch(() => {
    selectedTraceId.value = null;
    selectedTrace.value = null;
  });
  if (route.value.view === "trace") go(requestsRoute(), { replace: true });
}

/** DELETE all traces on the server; the `clear` SSE event empties local state in every open tab. */
export async function clearTraces(): Promise<void> {
  if (clearing.value) return;
  clearing.value = true;
  try {
    const ok = await api.clearTraces();
    // Apply locally too, in case the SSE stream is down.
    if (ok) {
      applyClear();
      actionError.value = null;
    } else actionError.value = "Could not clear traces";
  } catch (err) {
    actionError.value = `Could not clear traces: ${(err as Error).message}`;
  } finally {
    clearing.value = false;
  }
}

function applyClear(): void {
  pendingFollow = null;
  cancelRefresh();
  batch(() => {
    tracesState.value = [];
    selectedTraceId.value = null;
    selectedTrace.value = null;
  });
  noteActivity("clear");
  const v = route.value.view;
  if (v === "trace" || v === "compare") go(requestsRoute(), { replace: true });
}

/* ------------------------------------------------------------------- route -> selection */

/**
 * Wire the hash router (plan 3.8) to the store; the route is the source of truth for the screen.
 *  - #/r/<id> selects and loads that trace (deep link, Back/Forward, manual edit, legacy #trace=).
 *  - Releasing the live hold applies the newest arrival when Follow is on.
 * The span part of #/r/<id>/s/<span> is synced by the shell (app.tsx), which can import
 * state/journey without a cycle. Call once; returns a disposer.
 */
export function initRouting(): () => void {
  const disposers = [
    initRouter(),
    effect(() => {
      const r = route.value;
      if (r.view !== "trace") return;
      const id = r.traceId;
      if (id === selectedTraceId.peek()) {
        // The store navigated here itself (a click, or Follow picking the latest arrival): only make
        // sure the record loads. Re-entering loadTrace(..., "hash") would pause Follow whenever
        // requests finish out of start order (the newest finished is not the newest started).
        if (selectedTrace.peek()?.id !== id) queueMicrotask(() => void fetchSelected(id));
        return;
      }
      // Outside the effect: loadTrace reads signals, which would subscribe this effect to them.
      queueMicrotask(() => {
        const now = route.peek();
        if (now.view === "trace" && now.traceId === id) void loadTrace(id, "hash");
      });
    }),
    effect(() => {
      if (liveHold.value || !followLive.peek()) return;
      const newest = tracesState.peek().find((t) => t.done && t.kind !== "asset")?.id;
      if (newest && newest !== selectedTraceId.peek()) scheduleFollow(newest);
    }),
  ];
  return () => {
    for (const d of disposers) d();
  };
}

/**
 * Upper bound on summaries kept client-side. The server's ring buffer (maxTraces, default 300)
 * is the real retention; this only stops a long-lived tab from growing without limit when the
 * server is configured larger. Older entries past it would 404 on click anyway.
 */
const MAX_CLIENT_TRACES = 2000;

function capTraces(list: TraceSummary[]): TraceSummary[] {
  return list.length > MAX_CLIENT_TRACES ? list.slice(0, MAX_CLIENT_TRACES) : list;
}

/**
 * Late-span reload of the open trace. The server already throttles `update` to one per 250 ms per
 * trace; this coalesces a burst into one GET and never changes the view, selection or Follow.
 */
const REFRESH_DEBOUNCE_MS = 300;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(id: string): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (selectedTrace.value?.id !== id) return;
    api.trace(id).then(
      (t) => {
        // Only if the user is still looking at it (and nothing replaced it meanwhile).
        if (selectedTraceId.value === id && selectedTrace.value?.id === id) selectedTrace.value = t;
      },
      () => {
        /* evicted or offline: keep what is shown */
      },
    );
  }, REFRESH_DEBOUNCE_MS);
}

function cancelRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

let liveConn: LiveConnection | null = null;
let helloSeen = false;

/**
 * Replace the local list with the server's after a reconnect. Rows the server no longer has are
 * dropped; if the open request is one of them, close it and say why instead of 404ing on it.
 */
export async function resyncTraces(): Promise<void> {
  let server: TraceSummary[];
  try {
    server = await api.traces();
  } catch {
    return; // still unreachable: the next hello retries
  }
  const ids = new Set(server.map((t) => t.id));
  const lost = tracesState.peek().filter((t) => !ids.has(t.id)).length;
  const sel = selectedTraceId.peek();
  const selectedGone = sel !== null && !ids.has(sel);
  if (selectedGone) pendingFollow = null;
  batch(() => {
    tracesState.value = server;
    if (selectedGone) {
      selectedTraceId.value = null;
      selectedTrace.value = null;
    }
    if (lost > 0)
      actionError.value = `Hoplens restarted: ${lost} older request${lost === 1 ? " is" : "s are"} no longer available.`;
  });
  noteActivity("bootstrap");
  const v = route.value.view;
  if (selectedGone && (v === "trace" || v === "compare")) go(requestsRoute(), { replace: true });
}

/** Open the SSE stream and keep tracesState in sync. Safe to call multiple times (reuses existing). */
export function startLive(): void {
  if (liveConn) return;
  liveConn = openLive(
    (ev) => {
      if (ev.type === "hello") {
        // The first hello is the initial connect (bootstrap already loaded the list). A later one is
        // a reconnect, and the server may have restarted meanwhile (next dev restarts its server
        // process), so the local list can name traces that no longer exist: resync from the server.
        if (helloSeen) void resyncTraces();
        helloSeen = true;
      } else if (ev.type === "clear") {
        applyClear();
      } else if (ev.type === "start") {
        tracesState.value = capTraces([ev.trace, ...tracesState.value.filter((t) => t.id !== ev.trace.id)]);
      } else if (ev.type === "done") {
        const list = tracesState.value;
        // A `done` without its `start` (e.g. reconnect mid-request) still has to show up.
        tracesState.value = list.some((t) => t.id === ev.trace.id)
          ? list.map((t) => (t.id === ev.trace.id ? ev.trace : t))
          : capTraces([ev.trace, ...list]);
        // Follow means "always show the newest finished trace". The old guard
        // (`!selectedTraceId`) made it stop after the first one.
        noteActivity("done");
        if (followLive.value && ev.trace.kind !== "asset") scheduleFollow(ev.trace.id);
        // A trace picked by hand while still in flight: reload it now that it's complete.
        else if (selectedTrace.value?.id === ev.trace.id && !selectedTrace.value.done && route.value.view === "trace")
          void fetchSelected(ev.trace.id);
      } else if (ev.type === "update") {
        // Late spans landed on a finished trace: refresh its summary (droppedSpans) in place, and
        // reload the open one so the late spans show up in the canvas.
        const list = tracesState.value;
        if (list.some((t) => t.id === ev.trace.id))
          tracesState.value = list.map((t) => (t.id === ev.trace.id ? ev.trace : t));
        if (selectedTrace.value?.id === ev.trace.id) scheduleRefresh(ev.trace.id);
        noteActivity("update");
      }
    },
    (status) => {
      liveStatus.value = status;
    },
  );
}

export function stopLive(): void {
  liveConn?.close();
  liveConn = null;
  liveStatus.value = "offline";
}

export function toggleFollow(): void {
  followLive.value = !followLive.value;
  // Turning Follow back on jumps to the newest finished trace right away.
  if (followLive.value) {
    const newest = newestFinishedId();
    if (newest && newest !== selectedTraceId.value) void loadTrace(newest, "follow");
  }
}
