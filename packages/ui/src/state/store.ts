import { batch, computed, signal } from "@preact/signals";
import { type LiveConnection, api, openLive } from "../api/client";
import type { Discovery, Meta, RouteInfo, TraceRecord, TraceSummary } from "../api/types";

type LoadState = "idle" | "loading" | "ready" | "error";
export type TrafficFilter = "all" | "route" | "page" | "error";
export type SidebarTab = "routes" | "traffic";

export const metaState = signal<Meta | null>(null);
export const routesState = signal<Discovery | null>(null);
export const tracesState = signal<TraceSummary[]>([]);
export const selectedTraceId = signal<string | null>(null);
export const selectedTrace = signal<TraceRecord | null>(null);
export const followLive = signal(true);
export const liveStatus = signal<"live" | "reconnecting" | "offline">("offline");
export const loadError = signal<string | null>(null);
export const loadStatus = signal<LoadState>("idle");

export const sidebarTab = signal<SidebarTab>("routes");
export const routeSearch = signal("");
export const trafficFilter = signal<TrafficFilter>("all");
/** "routeId::METHOD" — identifies which route+method pair the request builder is editing. */
export const selectedRouteKey = signal<string | null>(null);

export const hasRoutes = computed(() => (routesState.value?.routes.length ?? 0) > 0);
export const hasTraces = computed(() => tracesState.value.length > 0);
export const tracesWithErrors = computed(() => tracesState.value.filter((t) => t.error).length);

export const filteredRoutes = computed(() => {
  const q = routeSearch.value.trim().toLowerCase();
  const all = routesState.value?.routes ?? [];
  if (!q) return all;
  return all.filter((r) => r.path.toLowerCase().includes(q) || r.file.toLowerCase().includes(q));
});

export const filteredTraces = computed(() => {
  const f = trafficFilter.value;
  const traces = tracesState.value;
  if (f === "all") return traces;
  if (f === "error") return traces.filter((t) => t.error || (t.status ?? 0) >= 400);
  return traces.filter((t) => t.kind === f);
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
  selectedRouteKey.value = `${route.id}::${method}`;
}

export function setSidebarTab(tab: SidebarTab): void {
  sidebarTab.value = tab;
}

export function setTrafficFilter(f: TrafficFilter): void {
  trafficFilter.value = f;
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
  } catch (err) {
    loadError.value = (err as Error).message;
    loadStatus.value = "error";
  }
}

/** Load one trace's full detail (hops, logs, bodies). Idempotent — bails if the id matches current. */
export async function loadTrace(id: string): Promise<void> {
  if (selectedTrace.value?.id === id) return;
  selectedTraceId.value = id;
  try {
    const t = await api.trace(id);
    selectedTrace.value = t;
  } catch (err) {
    loadError.value = (err as Error).message;
  }
}

export function clearSelection(): void {
  batch(() => {
    selectedTraceId.value = null;
    selectedTrace.value = null;
  });
}

let liveConn: LiveConnection | null = null;

/** Open the SSE stream and keep tracesState in sync. Safe to call multiple times (reuses existing). */
export function startLive(): void {
  if (liveConn) return;
  liveConn = openLive(
    (ev) => {
      if (ev.type === "clear") {
        batch(() => {
          tracesState.value = [];
          selectedTraceId.value = null;
          selectedTrace.value = null;
        });
      } else if (ev.type === "start") {
        tracesState.value = [ev.trace, ...tracesState.value.filter((t) => t.id !== ev.trace.id)];
      } else if (ev.type === "done") {
        tracesState.value = tracesState.value.map((t) => (t.id === ev.trace.id ? ev.trace : t));
        if (followLive.value && !selectedTraceId.value) void loadTrace(ev.trace.id);
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
}
