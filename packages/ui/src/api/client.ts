import type {
  Discovery,
  Meta,
  QueriesResponse,
  RunInput,
  RunResult,
  SourceResponse,
  StatsResponse,
  TraceRecord,
  TraceSummary,
} from "./types";

// Hoplens serves the UI at /__hoplens/ and the API under /__hoplens/api. In Vite dev the proxy
// in vite.config.ts rewrites both to the standalone runtime port on 127.0.0.1:4983.
const API = "/__hoplens/api";

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new HoplensApiError(res.status, await res.text().catch(() => res.statusText), path);
  return (await res.json()) as T;
}

export class HoplensApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`${status} ${path}: ${body.slice(0, 160)}`);
    this.name = "HoplensApiError";
  }
}

export const api = {
  meta: () => get<Meta>("/meta"),
  routes: (fresh = false) => get<Discovery>(`/routes${fresh ? "?fresh=1" : ""}`),
  traces: () => get<TraceSummary[]>("/traces"),
  /**
   * Server-side search (`?q=`): free text also covers logs and request/response bodies. Terms the
   * server dropped come back in the x-hoplens-query-errors header.
   */
  searchTraces: async (q: string, init?: RequestInit): Promise<{ traces: TraceSummary[]; errors: string[] }> => {
    const path = `/traces?q=${encodeURIComponent(q)}`;
    const res = await fetch(`${API}${path}`, { ...init, headers: { accept: "application/json" } });
    if (!res.ok) throw new HoplensApiError(res.status, await res.text().catch(() => res.statusText), path);
    let errors: string[] = [];
    try {
      const h = res.headers.get("x-hoplens-query-errors");
      if (h) errors = JSON.parse(decodeURIComponent(h)) as string[];
    } catch {
      /* malformed header: ignore */
    }
    return { traces: (await res.json()) as TraceSummary[], errors };
  },
  /** Per-route, per-epoch aggregates that survive ring eviction. 404 on an older core. */
  stats: (buckets = false) => get<StatsResponse>(`/stats${buckets ? "?buckets=1" : ""}`),
  /** Cross-request query / host fingerprints. */
  queries: (limit = 500) => get<QueriesResponse>(`/queries?limit=${limit}`),
  trace: (id: string) => get<TraceRecord>(`/traces/${encodeURIComponent(id)}`),
  rawRequest: (id: string) =>
    get<{ method: string; url: string; headers: Record<string, string>; body?: string }>(
      `/traces/${encodeURIComponent(id)}/request`,
    ),
  source: (file: string, line: number, context = 10) =>
    get<SourceResponse>(`/source?file=${encodeURIComponent(file)}&line=${line}&context=${context}`),
  clearTraces: () => fetch(`${API}/traces`, { method: "DELETE" }).then((r) => r.ok),
  run: async (input: RunInput): Promise<RunResult> => {
    const res = await fetch(`${API}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new HoplensApiError(res.status, JSON.stringify(body), "/run");
    return body as RunResult;
  },
};

/* ----------------------------------------------------------- SSE live events */

export type LiveEvent =
  | { type: "hello" }
  | { type: "start"; trace: TraceSummary }
  | { type: "done"; trace: TraceSummary }
  /** A finished trace changed (late spans; facts.droppedSpans updated). Throttled server-side to 1 per 250 ms per trace. */
  | { type: "update"; trace: TraceSummary }
  | { type: "clear" };

export interface LiveConnection {
  close(): void;
}

/**
 * Open the live-event SSE stream and invoke `onEvent` for each parsed event.
 * Reconnects with a capped backoff (1s → 30s) on disconnect. The returned
 * handle closes both the EventSource and any pending reconnect timer.
 */
export function openLive(
  onEvent: (ev: LiveEvent) => void,
  onStatus?: (status: "live" | "reconnecting") => void,
): LiveConnection {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  let closed = false;

  const connect = () => {
    if (closed) return;
    onStatus?.("live");
    source = new EventSource(`${API}/events`);
    source.addEventListener("hello", () => onEvent({ type: "hello" }));
    source.addEventListener("start", (e) => {
      try {
        onEvent({ type: "start", trace: JSON.parse((e as MessageEvent).data) });
      } catch {
        /* ignore malformed */
      }
    });
    source.addEventListener("done", (e) => {
      try {
        onEvent({ type: "done", trace: JSON.parse((e as MessageEvent).data) });
      } catch {
        /* ignore malformed */
      }
    });
    source.addEventListener("update", (e) => {
      try {
        onEvent({ type: "update", trace: JSON.parse((e as MessageEvent).data) });
      } catch {
        /* ignore malformed */
      }
    });
    source.addEventListener("clear", () => onEvent({ type: "clear" }));
    source.onopen = () => {
      delay = 1000;
    };
    source.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      onStatus?.("reconnecting");
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };

  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
      source = null;
    },
  };
}
