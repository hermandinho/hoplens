import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import type { HostStat, QueryKind, QueryStat, TraceSummary } from "../api/types";
import {
  type HostSortKey,
  type QuerySortKey,
  STATUS_BUCKETS,
  queriesData,
  queriesError,
  queriesState,
  refreshQueries,
  sortHosts,
  sortQueries,
  statusHistogram,
} from "../state/queries";
import { openSourceAt } from "../state/source";
import { fmtMs, fmtPct, statusClass } from "../state/stats";
import { actionError, loadTrace, tracesState } from "../state/store";
import { Skeleton } from "./Skeleton";

/*
 * Queries view (plan feature 11): every db / cache / fetch fingerprint across requests, and the
 * hosts the app calls. Data from GET /api/queries, kept server-side so it survives ring eviction.
 */

type Tab = "queries" | "hosts";
const tab = signal<Tab>("queries");
const kindFilter = signal<QueryKind | "all">("all");
const qSort = signal<{ by: QuerySortKey; desc: boolean }>({ by: "totalMs", desc: true });
const hSort = signal<{ by: HostSortKey; desc: boolean }>({ by: "calls", desc: true });
const expanded = signal<ReadonlySet<string>>(new Set());

const SUPPORTED_DB =
  "pg (node-postgres), Prisma with tracing enabled, Drizzle through drizzleLogger() from @hoplens/core/trace, ioredis, node-redis, and any OpenTelemetry span carrying db.system / db.statement";

export function QueriesView() {
  const state = queriesState.value;
  const data = queriesData.value;
  const t = tab.value;

  return (
    <section class="queries-view" aria-labelledby="queries-title">
      <header class="ov-head">
        <div>
          <h2 id="queries-title" class="ov-title">
            Queries
          </h2>
          <div class="ov-sub dim">
            Every database, cache and fetch call across requests, grouped by shape. Kept server-side: survives trace
            eviction, resets on Clear.
          </div>
        </div>
        <div class="ov-head-tools">
          <button
            type="button"
            class="chip"
            onClick={() =>
              void refreshQueries().then(() => {
                if (queriesState.value === "error") actionError.value = `Could not load queries: ${queriesError.value}`;
                else if (actionError.value?.startsWith("Could not load queries")) actionError.value = null;
              })
            }
            disabled={state === "loading"}
          >
            Refresh
          </button>
        </div>
      </header>

      <div class="qv-tabs" role="tablist" aria-label="Queries or hosts">
        <TabBtn id="queries" label="Queries" count={data?.queries.length} />
        <TabBtn id="hosts" label="Hosts" count={data?.hosts.length} />
      </div>

      <div role="tabpanel" id={`qv-panel-${t}`} aria-labelledby={`qv-tab-${t}`} class="qv-panel">
        {state === "unavailable" ? (
          <div class="ov-empty">
            <b>Not available</b>
            This Hoplens runtime has no <code>/api/queries</code> endpoint. Update <code>@hoplens/core</code> and
            restart <code>next dev</code>.
          </div>
        ) : !data && (state === "loading" || state === "idle") ? (
          <div class="skeleton-wrap" aria-busy="true">
            <Skeleton lines={6} />
          </div>
        ) : !data && state === "error" ? (
          <div class="error" role="alert">
            <b>Could not load queries.</b> {queriesError.value}{" "}
            <button type="button" class="link-btn" onClick={() => void refreshQueries()}>
              Retry
            </button>
          </div>
        ) : data ? (
          <>
            {state === "error" && (
              <output class="qv-stale dim">Refresh failed ({queriesError.value}); showing the last snapshot.</output>
            )}
            {t === "queries" ? <QueriesTable list={data.queries} /> : <HostsTable list={data.hosts} />}
          </>
        ) : null}
      </div>
    </section>
  );
}

function TabBtn({ id, label, count }: { id: Tab; label: string; count?: number }) {
  const on = tab.value === id;
  return (
    <button
      type="button"
      role="tab"
      id={`qv-tab-${id}`}
      aria-selected={on}
      aria-controls={`qv-panel-${id}`}
      class={`sidebar-tab ${on ? "active" : ""}`}
      onClick={() => (tab.value = id)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const next: Tab = id === "queries" ? "hosts" : "queries";
          tab.value = next;
          document.getElementById(`qv-tab-${next}`)?.focus();
        }
      }}
      tabIndex={on ? 0 : -1}
    >
      {label}
      {count !== undefined && <span class="tab-count">{count}</span>}
    </button>
  );
}

/** Sortable column header with aria-sort. */
function SortTh<K extends string>({
  k,
  sort,
  onSort,
  children,
  title,
  cls = "",
}: {
  k: K;
  sort: { by: K; desc: boolean };
  onSort: (k: K) => void;
  children: ComponentChildren;
  title?: string;
  cls?: string;
}) {
  const on = sort.by === k;
  return (
    <th
      scope="col"
      class={`num ${cls}`}
      aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
      title={title}
    >
      <button type="button" class={`th-sort ${on ? "th-sort-on" : ""}`} onClick={() => onSort(k)}>
        {children}
        <span class="th-arrow" aria-hidden="true">
          {on ? (sort.desc ? "▾" : "▴") : ""}
        </span>
      </button>
    </th>
  );
}

function toggleSort<K extends string>(sig: { value: { by: K; desc: boolean } }, k: K): void {
  const cur = sig.value;
  sig.value = cur.by === k ? { by: k, desc: !cur.desc } : { by: k, desc: true };
}

function shortFile(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : file;
}

/* ------------------------------------------------------------------- queries */

const KINDS: Array<{ id: QueryKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "db", label: "Database" },
  { id: "cache", label: "Cache" },
  { id: "fetch", label: "Fetch" },
];

function QueriesTable({ list }: { list: QueryStat[] }) {
  const kind = kindFilter.value;
  const sort = qSort.value;
  const open = expanded.value;
  const rows = sortQueries(kind === "all" ? list : list.filter((q) => q.kind === kind), sort.by, sort.desc);
  const hasDb = list.some((q) => q.kind === "db");

  return (
    <>
      <fieldset class="chips qv-kinds">
        <legend class="sr-only">Filter by kind</legend>
        {KINDS.map((k) => {
          const n = k.id === "all" ? list.length : list.filter((q) => q.kind === k.id).length;
          return (
            <button
              key={k.id}
              type="button"
              class={`chip ${kind === k.id ? "chip-active" : ""}`}
              aria-pressed={kind === k.id}
              onClick={() => (kindFilter.value = k.id)}
            >
              {k.label} <span class="dim">{n}</span>
            </button>
          );
        })}
      </fieldset>

      {!hasDb && (kind === "all" || kind === "db") && (
        <div class="qv-note dim">
          No db spans seen{list.length > 0 ? " yet" : ""}. Supported drivers: {SUPPORTED_DB}. A route that waits on an
          unsupported driver shows the time as idle.
        </div>
      )}

      {rows.length === 0 ? (
        <div class="ov-empty">
          <b>{list.length === 0 ? "No queries yet" : "Nothing of this kind"}</b>
          {list.length === 0
            ? "Send requests that hit a database, a cache or an external API. Each call is grouped by its shape here, with literals and ids replaced by ?."
            : "Try another kind."}
        </div>
      ) : (
        <div class="ov-table-wrap">
          <table class="ov-table qv-table">
            <thead>
              <tr>
                <th scope="col">
                  <span class="sr-only">Expand</span>
                </th>
                <th scope="col">Shape</th>
                <th scope="col">Kind</th>
                <SortTh k="calls" sort={sort} onSort={(k) => toggleSort(qSort, k)}>
                  Calls
                </SortTh>
                <SortTh
                  k="traces"
                  sort={sort}
                  onSort={(k) => toggleSort(qSort, k)}
                  title="Distinct requests; calls per request above 1 hints at a loop"
                >
                  Reqs
                </SortTh>
                <SortTh k="totalMs" sort={sort} onSort={(k) => toggleSort(qSort, k)}>
                  Total
                </SortTh>
                <SortTh k="p95Ms" sort={sort} onSort={(k) => toggleSort(qSort, k)}>
                  p95
                </SortTh>
                <SortTh k="maxMs" sort={sort} onSort={(k) => toggleSort(qSort, k)} cls="qv-col-opt">
                  Max
                </SortTh>
                <SortTh k="errors" sort={sort} onSort={(k) => toggleSort(qSort, k)} cls="qv-col-opt">
                  Err
                </SortTh>
                <th scope="col" class="qv-col-opt">
                  Routes
                </th>
                <th scope="col">Callers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <QueryRow key={q.fingerprint} q={q} open={open.has(q.fingerprint)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function toggleExpanded(fp: string): void {
  const next = new Set(expanded.value);
  if (next.has(fp)) next.delete(fp);
  else next.add(fp);
  expanded.value = next;
}

function QueryRow({ q, open }: { q: QueryStat; open: boolean }) {
  const perReq = q.traces > 0 ? q.calls / q.traces : 0;
  const caller = q.callers[0];
  const detailId = `qv-detail-${q.fingerprint.length}-${hash(q.fingerprint)}`;
  return (
    <>
      <tr class={`ov-row qv-row ${open ? "qv-row-open" : ""}`}>
        <td class="qv-caret-cell">
          <button
            type="button"
            class="qv-caret"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`${open ? "Hide" : "Show"} details for ${q.shape}`}
            onClick={() => toggleExpanded(q.fingerprint)}
          >
            {open ? "▾" : "▸"}
          </button>
        </td>
        <th scope="row" class="qv-shape mono" title={q.shape}>
          <span class="qv-clip">{q.shape}</span>
        </th>
        <td>
          <span class={`qv-kind qv-kind-${q.kind}`}>{q.system && q.kind !== "fetch" ? q.system : q.kind}</span>
        </td>
        <td class="num mono">{q.calls}</td>
        <td class={`num mono ${perReq > 1.5 ? "qv-loop" : ""}`} title={`${perReq.toFixed(1)} calls per request`}>
          {q.traces}
          {perReq > 1.5 && <span class="dim"> ×{perReq.toFixed(perReq >= 10 ? 0 : 1)}</span>}
        </td>
        <td class="num mono">{q.timedCalls > 0 ? fmtMs(q.totalMs) : "—"}</td>
        <td class="num mono">{fmtMs(q.p95Ms)}</td>
        <td class="num mono qv-col-opt">{fmtMs(q.maxMs)}</td>
        <td class={`num mono qv-col-opt ${q.errors > 0 ? "ov-err" : "dim"}`}>{q.errors}</td>
        <td class="qv-routes mono qv-col-opt">
          {q.routes[0] ? (
            <>
              <span class="qv-clip" title={q.routes.map((r) => `${r.route} ×${r.calls}`).join("\n")}>
                {q.routes[0].route}
              </span>
              {q.routes.length > 1 && <span class="dim"> +{q.routes.length - 1}</span>}
            </>
          ) : (
            <span class="dim">—</span>
          )}
        </td>
        <td class="qv-callers">
          {caller ? <CallerLink c={caller} /> : <span class="dim">—</span>}
          {q.callers.length > 1 && <span class="dim"> +{q.callers.length - 1}</span>}
        </td>
      </tr>
      {open && (
        <tr class="qv-detail-row" id={detailId}>
          <td />
          <td colSpan={10}>
            <QueryDetail q={q} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Small stable hash for DOM ids. */
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function CallerLink({ c }: { c: QueryStat["callers"][number] }) {
  const loc = c.location;
  const label = `${c.fn ?? "(anonymous)"}`;
  if (!loc)
    return (
      <span class="mono" title={`${c.calls} calls`}>
        {label}
      </span>
    );
  return (
    <button
      type="button"
      class="stack-link mono"
      onClick={() => openSourceAt(loc.file, loc.line)}
      title={`${loc.file}:${loc.line} · ${c.calls} calls · open in source viewer`}
    >
      {c.fn ? `${c.fn} ` : ""}
      {shortFile(loc.file)}:{loc.line}
    </button>
  );
}

function QueryDetail({ q }: { q: QueryStat }) {
  const byId = new Map<string, TraceSummary>();
  for (const t of tracesState.value) byId.set(t.id, t);
  return (
    <div class="qv-detail">
      <pre class="qv-full mono">{q.shape}</pre>
      <dl class="qv-facts mono">
        {q.system && (
          <>
            <dt>system</dt>
            <dd>{q.system}</dd>
          </>
        )}
        <dt>avg</dt>
        <dd>{fmtMs(q.avgMs)}</dd>
        <dt>max</dt>
        <dd>{fmtMs(q.maxMs)}</dd>
        <dt>errors</dt>
        <dd class={q.errors > 0 ? "ov-err" : undefined}>{q.errors}</dd>
        <dt>timed calls</dt>
        <dd>
          {q.timedCalls} of {q.calls}
        </dd>
        {q.avgRows !== undefined && (
          <>
            <dt>avg rows</dt>
            <dd>{q.avgRows.toFixed(1)}</dd>
          </>
        )}
        {(q.hits !== undefined || q.misses !== undefined) && (
          <>
            <dt>cache</dt>
            <dd>
              {q.hits ?? 0} hit / {q.misses ?? 0} miss
            </dd>
          </>
        )}
      </dl>
      <div class="qv-cols">
        <div>
          <h4 class="qv-h">Callers</h4>
          {q.callers.length === 0 ? (
            <div class="dim">No caller location recorded.</div>
          ) : (
            <ul class="qv-ul">
              {q.callers.map((c) => (
                <li key={`${c.fn}-${c.location?.file}-${c.location?.line}`}>
                  <CallerLink c={c} /> <span class="dim mono">×{c.calls}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 class="qv-h">Routes</h4>
          <ul class="qv-ul">
            {q.routes.map((r) => (
              <li key={r.route} class="mono">
                {r.route} <span class="dim">×{r.calls}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 class="qv-h">Sample requests</h4>
          {q.traceIds.length === 0 ? (
            <div class="dim">The requests that made these calls were evicted.</div>
          ) : (
            <ul class="qv-ul">
              {q.traceIds.map((id) => {
                const t = byId.get(id);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      class="qv-sample"
                      onClick={() => void loadTrace(id, "user")}
                      title="Open this request"
                    >
                      {t ? (
                        <>
                          <span class={`status-code ${statusClass(t)}`}>{t.status ?? "—"}</span>
                          <span class={`method-tag m-${t.method}`}>{t.method}</span>
                          <span class="mono qv-sample-path">{t.path}</span>
                          <span class="mono dim">{fmtMs(t.duration)}</span>
                        </>
                      ) : (
                        <span class="mono">{id.slice(0, 12)}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- hosts */

function HostsTable({ list }: { list: HostStat[] }) {
  const sort = hSort.value;
  const rows = sortHosts(list, sort.by, sort.desc);
  if (rows.length === 0)
    return (
      <div class="ov-empty">
        <b>No outgoing fetches yet</b>
        Hosts appear once a request calls <code>fetch()</code>: calls, p95, error rate and how many GETs asked for
        Next's data cache.
      </div>
    );
  return (
    <div class="ov-table-wrap">
      <table class="ov-table qv-table">
        <thead>
          <tr>
            <th scope="col">Host</th>
            <SortTh k="calls" sort={sort} onSort={(k) => toggleSort(hSort, k)}>
              Calls
            </SortTh>
            <SortTh k="p95Ms" sort={sort} onSort={(k) => toggleSort(hSort, k)}>
              p95
            </SortTh>
            <th scope="col" class="num qv-col-opt">
              Avg
            </th>
            <SortTh k="errorPct" sort={sort} onSort={(k) => toggleSort(hSort, k)} title="Failed, or HTTP >= 400">
              Err %
            </SortTh>
            <SortTh
              k="cachedPct"
              sort={sort}
              onSort={(k) => toggleSort(hSort, k)}
              title="GETs that asked for Next's data cache (force-cache, revalidate > 0). Request-side intent, not an observed hit."
            >
              Cached %
            </SortTh>
            <th scope="col" class="num qv-col-opt" title="GETs that opted out explicitly (no-store, revalidate: 0)">
              No-store %
            </th>
            <th scope="col">Statuses</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.host} class="ov-row">
              <th scope="row" class="mono qv-host">
                {h.host || <span class="dim">(this app, relative URL)</span>}
              </th>
              <td class="num mono">{h.calls}</td>
              <td class="num mono">{fmtMs(h.p95Ms)}</td>
              <td class="num mono dim qv-col-opt">{fmtMs(h.avgMs)}</td>
              <td class={`num mono ${h.errorPct > 0 ? "ov-err" : "dim"}`}>{fmtPct(h.errorPct)}</td>
              <td class="num mono">{fmtPct(h.cachedPct)}</td>
              <td class="num mono dim qv-col-opt">{fmtPct(h.uncachedPct)}</td>
              <td>
                <StatusBar statuses={h.statuses} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Stacked mini-bar of response statuses: 2xx / 3xx / 4xx / 5xx / failed without a status. */
function StatusBar({ statuses }: { statuses: Record<string, number> }) {
  const h = statusHistogram(statuses);
  const total = STATUS_BUCKETS.reduce((s, b) => s + h[b], 0);
  if (total === 0) return <span class="dim">—</span>;
  const detail = Object.entries(statuses)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}: ${n}`)
    .join(", ");
  return (
    <span class="status-bar" role="img" aria-label={`Statuses: ${detail}`} title={detail}>
      {STATUS_BUCKETS.map((b) =>
        h[b] > 0 ? <span key={b} class={`status-seg st-${b}`} style={{ width: `${(h[b] / total) * 100}%` }} /> : null,
      )}
    </span>
  );
}
