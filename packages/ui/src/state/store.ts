import { batch, computed, signal } from "@preact/signals";
import { api, openLive, type LiveConnection } from "../api/client";
import type { Discovery, Meta, TraceRecord, TraceSummary } from "../api/types";

type LoadState = "idle" | "loading" | "ready" | "error";

export const metaState = signal<Meta | null>(null);
export const routesState = signal<Discovery | null>(null);
export const tracesState = signal<TraceSummary[]>([]);
export const selectedTraceId = signal<string | null>(null);
export const selectedTrace = signal<TraceRecord | null>(null);
export const followLive = signal(true);
export const liveStatus = signal<"live" | "reconnecting" | "offline">("offline");
export const loadError = signal<string | null>(null);
export const loadStatus = signal<LoadState>("idle");

export const hasRoutes = computed(() => (routesState.value?.routes.length ?? 0) > 0);
export const hasTraces = computed(() => tracesState.value.length > 0);
export const tracesWithErrors = computed(() => tracesState.value.filter((t) => t.error).length);

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
