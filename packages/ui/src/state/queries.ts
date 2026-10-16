import { batch, computed, effect, signal, untracked } from "@preact/signals";
import { HoplensApiError, api } from "../api/client";
import type { HostStat, QueriesResponse, QueryKind, QueryStat } from "../api/types";
import { clearedAt, liveActivity, throttle } from "./activity";
import { go, route } from "./router";
import { holdOrder as holdKeyOrder } from "./stats";
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

export function sortQueries(list: readonly QueryStat[], by: QuerySortKey, desc: boolean): QueryStat[] {
  const v = (q: QueryStat) => q[by] ?? -1;
  return [...list].sort(
    (a, b) => (desc ? v(b) - v(a) : v(a) - v(b)) || b.totalMs - a.totalMs || a.fingerprint.localeCompare(b.fingerprint),
  );
}

/* ----------------------------------------------------- list | subject (plan 3.8) */

/** `#/q/<shape>`: the route names a shape by its fingerprint; a bare shape is accepted too. */
export function findShape(list: readonly QueryStat[], key: string | undefined): QueryStat | undefined {
  if (!key) return undefined;
  return list.find((q) => q.fingerprint === key) ?? list.find((q) => q.shape === key);
}

/** Open a shape as the subject (push), or step to it with j/k (replace). The since scope carries over. */
export function selectShape(fingerprint: string, opts: { replace?: boolean } = {}): void {
  const since = route.peek().since;
  go(since ? { view: "queries", shape: fingerprint, since } : { view: "queries", shape: fingerprint }, opts);
}

export function closeShape(): void {
  const since = route.peek().since;
  go(since ? { view: "queries", since } : { view: "queries" });
}

/**
 * j/k over the list as shown: the next/previous fingerprint, or the first/last when nothing is
 * selected (or the selection left the list). undefined = nothing to move to.
 */
export function stepShape(rows: readonly QueryStat[], current: string | undefined, delta: number): string | undefined {
  if (rows.length === 0) return undefined;
  const i = current ? rows.findIndex((q) => q.fingerprint === current) : -1;
  if (i < 0) return (delta > 0 ? rows[0] : rows[rows.length - 1])?.fingerprint;
  return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]?.fingerprint;
}

/**
 * Plan 3.1 #5, never re-sort under the cursor: while the list is held (pointer on it, focus in the
 * subject) keep the order it had when the hold began. Known rows take their frozen place with
 * fresh numbers; shapes first seen during the hold go at the end and are counted as `fresh`.
 */
export function holdOrder(
  rows: readonly QueryStat[],
  frozen: readonly string[] | null,
): { rows: QueryStat[]; fresh: number } {
  const out = holdKeyOrder(frozen, rows, (q) => q.fingerprint);
  const at = new Set(frozen ?? []);
  return { rows: out, fresh: frozen ? rows.filter((q) => !at.has(q.fingerprint)).length : 0 };
}

/** The list pauses its order while held (set by the Queries split, like the request log's hold). */
export const queriesHold = signal(false);

/* --------------------------------------------------------------- list state */

export type KindFilter = QueryKind | "all";
export const queryKind = signal<KindFilter>("all");
export const querySort = signal<{ by: QuerySortKey; desc: boolean }>({ by: "totalMs", desc: true });
/** Hosts is a toggle inside Queries (plan 3.8): fetch shapes grouped under their host. */
export const groupHosts = signal(false);
/** The order frozen by the hold (fingerprints as shown when it began); null = live order. */
export const frozenOrder = signal<readonly string[] | null>(null);

export interface ShownShapes {
  /** In display order (flattened groups when grouped): what j/k walks. */
  rows: QueryStat[];
  /** Shapes that arrived during the hold, listed at the end. */
  fresh: number;
  /** Host groups when grouping by host. */
  groups: HostGroup[] | null;
}

export const shownShapes = computed((): ShownShapes => {
  const d = queriesData.value;
  if (!d) return { rows: [], fresh: 0, groups: null };
  const byHost = groupHosts.value;
  const kind = byHost ? "fetch" : queryKind.value;
  const list = kind === "all" ? d.queries : d.queries.filter((q) => q.kind === kind);
  const s = querySort.value;
  const held = holdOrder(sortQueries(list, s.by, s.desc), frozenOrder.value);
  if (!byHost) return { ...held, groups: null };
  // Held: the groups keep the order the frozen rows give them; else they follow the column sort.
  const groups = groupByHost(held.rows, d.hosts, frozenOrder.value ? "listed" : s);
  return { rows: groups.flatMap((g) => g.shapes), fresh: held.fresh, groups };
});

/** Freeze the order shown right now (the hold began, or the reader changed sort/kind/grouping). */
function freezeNow(): void {
  batch(() => {
    frozenOrder.value = null;
    frozenOrder.value = shownShapes.value.rows.map((q) => q.fingerprint);
  });
}

effect(() => {
  if (!queriesHold.value) frozenOrder.value = null;
  // Untracked: the hold flipping is the only trigger, not every refresh of the list it reads.
  else if (!frozenOrder.peek()) untracked(freezeNow);
});

/** Apply a list setting the reader chose: it takes effect at once, even while the list is held. */
export function setListOption(apply: () => void): void {
  batch(() => {
    apply();
    if (queriesHold.peek()) freezeNow();
  });
}

/** "N new": take the shapes that arrived during the hold into their sorted place. */
export function showFreshShapes(): void {
  if (queriesHold.peek()) freezeNow();
  else frozenOrder.value = null;
}

/** Calls per request, the loop hint: above LOOP_PER_REQ a shape most likely runs in a loop. */
export const LOOP_PER_REQ = 1.5;

export function perRequest(q: Pick<QueryStat, "calls" | "traces">): number {
  return q.traces > 0 ? q.calls / q.traces : 0;
}

/** "x12", "x2.5": the loop marker's text (ASCII x keeps it searchable; the UI shows a times sign). */
export function fmtPerRequest(n: number): string {
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
}

/* ---------------------------------------------------------- group by host */

/**
 * Host of a fetch shape. Fetch fingerprints are "METHOD host/path?keys" (core facts.normalizeUrl);
 * a relative URL (the app calling itself) has no host and yields "".
 */
export function hostOfShape(shape: string): string {
  const sp = shape.indexOf(" ");
  const rest = sp >= 0 ? shape.slice(sp + 1) : shape;
  // A relative URL starts with "/": the host is the empty prefix before it.
  const end = rest.search(/[/?#]/);
  return (end < 0 ? rest : rest.slice(0, end)).toLowerCase();
}

export interface HostGroup {
  host: string;
  /** The server's per-host stats; absent when only the shapes survived. */
  stat?: HostStat;
  /** In the order given (the list's sort). */
  shapes: QueryStat[];
}

/** The column sort applied to whole host groups: summed for totals and counts, the worst for p95 / max. */
function hostMetric(shapes: readonly QueryStat[], by: QuerySortKey): number {
  let out = 0;
  for (const q of shapes) {
    const v = q[by] ?? 0;
    out = by === "p95Ms" || by === "maxMs" ? Math.max(out, v) : out + v;
  }
  return out;
}

/**
 * The Queries list grouped by host (Hosts is a toggle in Queries, plan 3.8): fetch shapes only.
 * `order` sorts the hosts like the column header says (r2: "Total" sorted the shapes, but the hosts
 * stayed in the server's by-calls order): a sort key orders them by their shapes' summed (or worst)
 * value; "listed" keeps the order the shapes come in (the list is held). Without it: the server's
 * order (most calls first), hosts the stats don't know about after them. A host with stats but no
 * retained shape is kept, last, so its numbers stay visible.
 */
export function groupByHost(
  queries: readonly QueryStat[],
  hosts: readonly HostStat[],
  order?: { by: QuerySortKey; desc: boolean } | "listed",
): HostGroup[] {
  const groups = new Map<string, HostGroup>();
  // Insertion order: the server's hosts first, then any host only a shape names.
  for (const h of hosts) groups.set(h.host, { host: h.host, stat: h, shapes: [] });
  for (const q of queries) {
    if (q.kind !== "fetch") continue;
    const host = hostOfShape(q.shape);
    let g = groups.get(host);
    if (!g) {
      g = { host, shapes: [] };
      groups.set(host, g);
    }
    g.shapes.push(q);
  }
  const out = [...groups.values()];
  if (!order) return out;
  const empty = out.filter((g) => g.shapes.length === 0);
  const full = out.filter((g) => g.shapes.length > 0);
  if (order === "listed") {
    const at = new Map(queries.map((q, i) => [q.fingerprint, i]));
    const first = (g: HostGroup) => at.get(g.shapes[0]?.fingerprint ?? "") ?? 0;
    full.sort((a, b) => first(a) - first(b));
  } else {
    const v = (g: HostGroup) => hostMetric(g.shapes, order.by);
    full.sort((a, b) => (order.desc ? v(b) - v(a) : v(a) - v(b)));
  }
  return [...full, ...empty];
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
