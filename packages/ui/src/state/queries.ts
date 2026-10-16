import { effect, signal } from "@preact/signals";
import { HoplensApiError, api } from "../api/client";
import type { HostStat, QueriesResponse, QueryStat } from "../api/types";
import { clearedAt, liveActivity, throttle } from "./activity";
import { mainView } from "./store";

/*
 * The Queries view's data: GET /api/queries (cross-request query and host fingerprints, kept on the
 * server so they survive ring eviction). Fetched when the view opens, then refetched on live
 * activity (throttled) only while it is showing.
 */

export const queriesData = signal<QueriesResponse | null>(null);
export const queriesState = signal<"idle" | "loading" | "ready" | "error" | "unavailable">("idle");
export const queriesError = signal<string | null>(null);

const REFRESH_MS = 2000;
let inflight = false;
let again = false;

export async function refreshQueries(): Promise<void> {
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  if (!queriesData.value) queriesState.value = "loading";
  try {
    const d = await api.queries();
    queriesData.value = d;
    queriesState.value = "ready";
    queriesError.value = null;
  } catch (err) {
    if (err instanceof HoplensApiError && err.status === 404) {
      queriesState.value = "unavailable";
      queriesError.value = null;
    } else {
      queriesState.value = "error";
      queriesError.value = (err as Error).message;
    }
  } finally {
    inflight = false;
    if (again) {
      again = false;
      scheduleQueriesRefresh();
    }
  }
}

const scheduleQueriesRefresh = throttle(() => void refreshQueries(), REFRESH_MS);

let wasShowing = false;
effect(() => {
  const showing = mainView.value === "queries";
  liveActivity.value;
  if (!showing) {
    wasShowing = false;
    return;
  }
  // Opening the view fetches at once; activity while it shows refetches, throttled.
  if (!wasShowing) {
    wasShowing = true;
    void refreshQueries();
  } else scheduleQueriesRefresh();
});
effect(() => {
  if (clearedAt.value === 0) return;
  queriesData.value = null;
});

/* ----------------------------------------------------------- pure helpers */

export type QuerySortKey = "totalMs" | "calls" | "p95Ms" | "maxMs" | "traces" | "errors";
export type HostSortKey = "calls" | "p95Ms" | "errorPct" | "cachedPct";

export function sortQueries(list: readonly QueryStat[], by: QuerySortKey, desc: boolean): QueryStat[] {
  const v = (q: QueryStat) => q[by] ?? -1;
  return [...list].sort(
    (a, b) => (desc ? v(b) - v(a) : v(a) - v(b)) || b.totalMs - a.totalMs || a.fingerprint.localeCompare(b.fingerprint),
  );
}

export function sortHosts(list: readonly HostStat[], by: HostSortKey, desc: boolean): HostStat[] {
  const v = (h: HostStat) => h[by] ?? -1;
  return [...list].sort(
    (a, b) => (desc ? v(b) - v(a) : v(a) - v(b)) || b.calls - a.calls || a.host.localeCompare(b.host),
  );
}

/** Status histogram buckets for the hosts' mini-bar, in display order. */
export type StatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "error";
export const STATUS_BUCKETS: readonly StatusBucket[] = ["2xx", "3xx", "4xx", "5xx", "error"];

export function statusHistogram(statuses: Record<string, number>): Record<StatusBucket, number> {
  const out: Record<StatusBucket, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, error: 0 };
  for (const [k, n] of Object.entries(statuses)) {
    const code = Number(k);
    if (!Number.isFinite(code) || code < 200) out.error += n;
    else if (code < 300) out["2xx"] += n;
    else if (code < 400) out["3xx"] += n;
    else if (code < 500) out["4xx"] += n;
    else out["5xx"] += n;
  }
  return out;
}
