import { batch, computed, signal } from "@preact/signals";
import { HoplensApiError, type LiveConnection, api, openLive } from "../api/client";
import type { Discovery, Meta, RouteInfo, TraceRecord, TraceSummary } from "../api/types";
import { noteActivity } from "./activity";
import { serverKpis, serverRouteBadges, serverRouteStats, serverStats } from "./serverStats";
import {
  type SparkMetric,
  computeKpis,
  computeRouteStats,
  groupFindings,
  isCountable,
  isError,
  routeBadges,
  sparkSeries,
} from "./stats";

type LoadState = "idle" | "loading" | "ready" | "error";
export type SidebarTab = "routes" | "traffic";
/**
 * "overview" = cross-request dashboard; "requests" = the dense request log; "queries" = the
 * cross-request query / host workbench; "workbench" = builder + journey + details for one trace.
 */
export type MainView = "overview" | "requests" | "queries" | "workbench";

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

export const sidebarTab = signal<SidebarTab>("routes");
export const routeSearch = signal("");
/** "routeId::METHOD" — identifies which route+method pair the request builder is editing. */
export const selectedRouteKey = signal<string | null>(null);

/** Landing view is the Overview; picking a route or a trace switches to the workbench. */
export const mainView = signal<MainView>("overview");
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
const SPARK_BINS = 24;
const SPARK_METRICS: readonly SparkMetric[] = ["requests", "p50", "p95", "errPct", "io"];
/** Overview sparklines, computed once per change instead of five times per render. */
export const sparks = computed(() => {
  const out = {} as Record<SparkMetric, Array<number | undefined>>;
  for (const m of SPARK_METRICS) out[m] = sparkSeries(finishedTraces.value, m, SPARK_BINS, includeCold.value);
  return out;
});

export const hasRoutes = computed(() => (routesState.value?.routes.length ?? 0) > 0);
export const hasTraces = computed(() => tracesState.value.length > 0);
/** Same definition as the Overview's Errors KPI (stats.isError: 5xx), so the counts agree. */
export const tracesWithErrors = computed(() => tracesState.value.filter(isError).length);

export const filteredRoutes = computed(() => {
  const q = routeSearch.value.trim().toLowerCase();
  const all = routesState.value?.routes ?? [];
  if (!q) return all;
  return all.filter((r) => r.path.toLowerCase().includes(q) || r.file.toLowerCase().includes(q));
});

/** Group routes by first visible path segment ("api", "admin", …). "/" items go under "root". */
export const groupedRoutes = computed((): Array<{ group: string; items: RouteInfo[] }> => {
  const groups = new Map<string, RouteInfo[]>();
  for (const r of filteredRoutes.value) {
    const parts = r.path.split("/").filter(Boolean);
    const key = parts[0] ?? "root";
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, items]) => ({ group, items }));
});

export function selectRoute(route: RouteInfo, method: string): void {
  batch(() => {
    selectedRouteKey.value = `${route.id}::${method}`;
    mainView.value = "workbench";
    builderOpen.value = true;
  });
  ensureSelectedLoaded();
}

/**
 * Open the builder drawer. With no route picked yet, pre-select the one the given request hit
 * (matched by route template and method) so "New request" from a trace starts somewhere useful.
 */
export function openBuilder(from?: { method: string; route?: string; path: string }): void {
  batch(() => {
    if (!selectedRouteKey.value && from) {
      const tpl = from.route ?? from.path;
      const route = routesState.value?.routes.find((r) => r.nextRoute === tpl || r.path === tpl);
      const m = route?.methods.find((x) => x.method === from.method) ?? route?.methods.find((x) => x.method === "ANY");
      if (route && m) selectedRouteKey.value = `${route.id}::${m.method}`;
    }
    mainView.value = "workbench";
    builderOpen.value = true;
  });
  ensureSelectedLoaded();
}

export function closeBuilder(): void {
  builderOpen.value = false;
}

export function setMainView(v: MainView): void {
  mainView.value = v;
  if (v === "workbench") ensureSelectedLoaded();
}

/** Follow only records the id while another view is up; fetch it once the workbench shows it. */
function ensureSelectedLoaded(): void {
  const id = selectedTraceId.value;
  if (id && selectedTrace.value?.id !== id) void loadTrace(id, "follow");
}

export function toggleIncludeCold(): void {
  includeCold.value = !includeCold.value;
}

export function setSidebarTab(tab: SidebarTab): void {
  sidebarTab.value = tab;
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
 * Load one trace's full detail (hops, logs, bodies). Idempotent — skips the fetch if the id is
 * already loaded. `source` says who asked:
 *  - "user": a click (traffic row, finding, route table). Switches to the workbench, and pauses
 *    Follow when the picked trace isn't the newest so the next arrival doesn't yank it away.
 *  - "hash": a #trace=<id> deep link. Switches to the workbench and, like a click, pauses Follow
 *    unless it is the newest trace, so the next arrival doesn't replace the linked one.
 *  - "follow": a live arrival. Leaves the current view alone, and only records the id while the
 *    Overview / Requests / Queries view is showing (setMainView fetches it on switch).
 * A finished trace that is already loaded is not fetched again; an in-flight one is (to complete it).
 */
export async function loadTrace(id: string, source: SelectSource = "user"): Promise<void> {
  if (source !== "follow") {
    batch(() => {
      mainView.value = "workbench";
      if (followLive.value && newestFinishedId() !== id) followLive.value = false;
    });
  }
  writeHash(id);
  if (selectedTrace.value?.id === id && selectedTrace.value.done) {
    selectedTraceId.value = id;
    return;
  }
  selectedTraceId.value = id;
  // Nothing outside the workbench shows the trace itself; setMainView fetches it on switch.
  if (source === "follow" && mainView.value !== "workbench") return;
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
    if (next && followLive.value) void loadTrace(next, "follow");
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
  writeHash(null);
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
  writeHash(null);
}

/* ------------------------------------------------------------------- #trace=<id> deep links */

const HASH_PREFIX = "#trace=";

export function readHashTraceId(hash: string): string | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const raw = hash.slice(HASH_PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function writeHash(id: string | null): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const next = id ? `${HASH_PREFIX}${encodeURIComponent(id)}` : "";
  if (location.hash === next) return;
  // Only ever remove our own hash; leave other anchors (e.g. #main from the skip link) alone.
  if (!next && !location.hash.startsWith(HASH_PREFIX)) return;
  // replaceState: Follow would otherwise push one history entry per request.
  history.replaceState(null, "", next || `${location.pathname}${location.search}`);
}

/** Select the trace named in location.hash, on load and on manual hash edits. Returns a disposer. */
export function initHashRouting(): () => void {
  const apply = () => {
    const id = readHashTraceId(location.hash);
    if (id && id !== selectedTraceId.value) void loadTrace(id, "hash");
  };
  apply();
  window.addEventListener("hashchange", apply);
  return () => window.removeEventListener("hashchange", apply);
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

/** Open the SSE stream and keep tracesState in sync. Safe to call multiple times (reuses existing). */
export function startLive(): void {
  if (liveConn) return;
  liveConn = openLive(
    (ev) => {
      if (ev.type === "clear") {
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
        else if (selectedTrace.value?.id === ev.trace.id && !selectedTrace.value.done)
          void loadTrace(ev.trace.id, "follow");
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
