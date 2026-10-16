import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { HostStat, QueryStat, TraceSummary } from "../api/types";
import { register } from "../state/keymap";
import {
  type HostGroup,
  type KindFilter,
  LOOP_PER_REQ,
  type QuerySortKey,
  STATUS_BUCKETS,
  type StatusBucket,
  closeShape,
  findShape,
  fmtPerRequest,
  groupHosts,
  hostOfShape,
  perRequest,
  queriesData,
  queriesError,
  queriesHold,
  queriesState,
  queryKind,
  querySort,
  refreshQueries,
  selectShape,
  setListOption,
  showFreshShapes,
  shownShapes,
  statusHistogram,
  stepShape,
} from "../state/queries";
import { findingQuery, quoteValue } from "../state/querySuggest";
import { prefillQuery } from "../state/requestLog";
import { route } from "../state/router";
import { openSourceAt } from "../state/source";
import { fmtMs, fmtPct, statusClass } from "../state/stats";
import { actionError, loadTrace, tracesState } from "../state/store";
import { Skeleton } from "./Skeleton";
import { Split } from "./Split";

/*
 * Queries view (plan 3.8): one list | subject split, like every view.
 *  - The list: every db / cache / fetch shape across requests (GET /api/queries, kept server-side so
 *    it survives ring eviction), segmented by kind, sortable, or grouped by host (Hosts is a toggle
 *    here, not a view of its own). Its order holds still while the pointer is on it.
 *  - The subject (#/q/<fingerprint>): the full shape, its numbers, the loop hint linked to the
 *    requests that show it, callers, routes and sample requests.
 * j / k step through the list as shown; the subject follows.
 */

const SUPPORTED_DB =
  "pg (node-postgres), Prisma with tracing enabled, Drizzle through drizzleLogger() from @hoplens/core/trace, ioredis, node-redis, and any OpenTelemetry span carrying db.system / db.statement";

const KINDS: Array<{ id: KindFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "db", label: "SQL" },
  { id: "cache", label: "Cache" },
  { id: "fetch", label: "Fetch" },
];

/** The shape the route names (#/q/<fingerprint>), if any. */
function routeShape(): string | undefined {
  const r = route.value;
  return r.view === "queries" ? r.shape : undefined;
}

/** j / k: the next / previous shape as listed; opens the first one when none is open. */
function step(delta: number): void {
  const r = route.peek();
  const cur = r.view === "queries" ? r.shape : undefined;
  const next = stepShape(shownShapes.peek().rows, cur, delta);
  if (next && next !== cur) selectShape(next, { replace: !!cur });
}

export function QueriesView() {
  const key = routeShape();

  // Registered while the view is mounted, so the cheatsheet lists them only here.
  useEffect(() => {
    const onQueries = () => route.peek().view === "queries";
    const offs = [
      register("list", "j", "Next query shape (the subject follows)", () => step(1), { when: onQueries, hint: "move" }),
      register("list", "k", "Previous query shape (the subject follows)", () => step(-1), {
        when: onQueries,
        hint: "move",
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  return (
    <Split
      id="queries-shapes"
      list={<ShapeList selected={key} />}
      listLabel="Query shapes"
      subject={key ? <ShapeSubject shapeKey={key} /> : null}
      subjectLabel="Query shape"
      listClass="split-scroll qv-listpane"
      subjectClass="split-scroll"
      onHold={(held) => {
        queriesHold.value = held;
      }}
    />
  );
}

/* ====================================================================== list */

function ShapeList({ selected }: { selected: string | undefined }) {
  const state = queriesState.value;
  const data = queriesData.value;
  const shown = shownShapes.value;
  const byHost = groupHosts.value;
  const kind = queryKind.value;
  const all = data?.queries ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  const selectedFp = data ? findShape(data.queries, selected)?.fingerprint : undefined;

  // The open shape's row in view: a deep link (#/q/...) lands before the data, and j/k can walk
  // past the fold. Once per shape, after the row exists.
  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!selectedFp || revealed.current === selectedFp) return;
    const row = listRef.current?.querySelector(`[data-fp="${CSS.escape(selectedFp)}"]`);
    if (!row) return;
    revealed.current = selectedFp;
    row.scrollIntoView({ block: "nearest" });
  });

  return (
    <section class="queries-view" aria-labelledby="queries-title" ref={listRef}>
      <header class="list-head qv-head">
        <h2 id="queries-title" class="list-title">
          Queries {data && <span class="count">{all.length}</span>}
        </h2>
        {shown.fresh > 0 && (
          <button
            type="button"
            class="new-pill"
            onClick={showFreshShapes}
            title="New shapes arrived while you were reading; the list held its order"
          >
            {shown.fresh} new
          </button>
        )}
        <span class="list-hint dim">
          <kbd>j</kbd> <kbd>k</kbd> move
        </span>
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
      </header>

      <div class="qv-tools">
        <fieldset class="qv-seg" disabled={byHost}>
          <legend class="sr-only">Kind</legend>
          {KINDS.map((k) => {
            const n = k.id === "all" ? all.length : all.filter((q) => q.kind === k.id).length;
            const on = (byHost ? "fetch" : kind) === k.id;
            return (
              <button
                key={k.id}
                type="button"
                class={`qv-seg-btn ${on ? "qv-seg-on" : ""}`}
                aria-pressed={on}
                onClick={() => setListOption(() => (queryKind.value = k.id))}
              >
                {k.label} <span class="dim mono">{n}</span>
              </button>
            );
          })}
        </fieldset>
        <button
          type="button"
          class={`chip ${byHost ? "chip-active" : ""}`}
          aria-pressed={byHost}
          title="Group the fetch shapes under the host they call, with each host's numbers"
          onClick={() => setListOption(() => (groupHosts.value = !groupHosts.value))}
        >
          Group by host {data && <span class="dim mono">{data.hosts.length}</span>}
        </button>
      </div>

      {state === "unavailable" ? (
        <div class="qv-empty">
          <b>Not available</b>
          This Hoplens runtime has no <code>/api/queries</code> endpoint. Update <code>@hoplens/core</code> and restart{" "}
          <code>next dev</code>.
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
          {!byHost && !all.some((q) => q.kind === "db") && (kind === "all" || kind === "db") && (
            <div class="qv-note dim">
              No SQL spans seen{all.length > 0 ? " yet" : ""}. Supported drivers: {SUPPORTED_DB}. A route that waits on
              an unsupported driver shows the time as idle.
            </div>
          )}
          <ShapeTable shown={shown.rows} groups={shown.groups} total={all.length} selected={selectedFp} />
        </>
      ) : null}
    </section>
  );
}

/** Sortable column header with aria-sort. */
function SortTh({
  k,
  children,
  title,
  cls = "",
}: {
  k: QuerySortKey;
  children: ComponentChildren;
  title?: string;
  cls?: string;
}) {
  const sort = querySort.value;
  const on = sort.by === k;
  return (
    <th
      scope="col"
      class={`num ${cls}`}
      aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
      title={title}
    >
      <button
        type="button"
        class={`th-sort ${on ? "th-sort-on" : ""}`}
        onClick={() =>
          setListOption(() => {
            querySort.value = on ? { by: k, desc: !sort.desc } : { by: k, desc: true };
          })
        }
      >
        {children}
        <span class="th-arrow" aria-hidden="true">
          {on ? (sort.desc ? "▾" : "▴") : ""}
        </span>
      </button>
    </th>
  );
}

const COLS = 7;

function ShapeTable({
  shown,
  groups,
  total,
  selected,
}: {
  shown: QueryStat[];
  groups: HostGroup[] | null;
  total: number;
  selected: string | undefined;
}) {
  if (groups ? groups.length === 0 : shown.length === 0) {
    return (
      <div class="qv-empty">
        <b>{total === 0 ? "No queries yet" : groups ? "No outgoing fetches yet" : "Nothing of this kind"}</b>
        {total === 0
          ? "Send requests that hit a database, a cache or an external API. Each call is grouped by its shape here, with literals and ids replaced by ?."
          : groups
            ? "Hosts appear once a request calls fetch(): calls, p95, error rate and how many GETs asked for Next's data cache."
            : "Try another kind."}
      </div>
    );
  }
  const row = (q: QueryStat) => <ShapeRow key={q.fingerprint} q={q} on={q.fingerprint === selected} />;
  return (
    <div class="qv-table-wrap">
      <table class="qv-table">
        <thead>
          <tr>
            <th scope="col">Shape</th>
            <SortTh k="calls">Calls</SortTh>
            <SortTh k="traces" title="Distinct requests" cls="qv-col-mid">
              Reqs
            </SortTh>
            <SortTh k="totalMs">Total</SortTh>
            <SortTh k="p95Ms">p95</SortTh>
            <SortTh k="maxMs" cls="qv-col-opt">
              Max
            </SortTh>
            <SortTh k="errors" cls="qv-col-opt">
              Err
            </SortTh>
          </tr>
        </thead>
        {groups ? (
          groups.map((g) => (
            <tbody key={g.host} class="qv-group">
              <HostRow g={g} />
              {g.shapes.map(row)}
            </tbody>
          ))
        ) : (
          <tbody>{shown.map(row)}</tbody>
        )}
      </table>
    </div>
  );
}

function KindDot({ q }: { q: QueryStat }) {
  return <span class={`qv-dot qv-dot-${q.kind}`} aria-hidden="true" />;
}

/** Loop marker: calls per request above LOOP_PER_REQ. Opens the newest request that shows it. */
function LoopChip({ q }: { q: QueryStat }) {
  const per = perRequest(q);
  if (per <= LOOP_PER_REQ) return null;
  const newest = q.traceIds[0];
  const text = `×${fmtPerRequest(per)}`;
  const title = `${fmtPerRequest(per)} calls per request: most likely a loop (N+1).`;
  if (!newest)
    return (
      <span class="qv-loop" title={title}>
        {text}
      </span>
    );
  return (
    <button
      type="button"
      class="qv-loop"
      title={`${title} Open the newest request that made them.`}
      aria-label={`${title} Open the newest request that made them`}
      onClick={(e) => {
        e.stopPropagation();
        void loadTrace(newest, "user");
      }}
    >
      {text}
    </button>
  );
}

function ShapeRow({ q, on }: { q: QueryStat; on: boolean }) {
  return (
    // The whole row is a click target for the mouse; the keyboard path is the shape button and j/k.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <tr
      class={`qv-row ${on ? "qv-row-on" : ""}`}
      data-fp={q.fingerprint}
      onClick={() => !on && selectShape(q.fingerprint)}
    >
      <th scope="row" class="qv-shape">
        <span class="qv-shape-cell">
          <button
            type="button"
            class="qv-open mono"
            title={q.shape}
            aria-current={on ? "true" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (!on) selectShape(q.fingerprint);
            }}
          >
            <KindDot q={q} />
            <span class="qv-clip">{q.shape}</span>
          </button>
          <LoopChip q={q} />
        </span>
      </th>
      <td class="num mono">{q.calls}</td>
      <td class="num mono qv-col-mid">{q.traces}</td>
      <td class="num mono">{q.timedCalls > 0 ? fmtMs(q.totalMs) : "—"}</td>
      <td class="num mono">{fmtMs(q.p95Ms)}</td>
      <td class="num mono qv-col-opt">{fmtMs(q.maxMs)}</td>
      <td class="num mono qv-col-opt">
        {q.errors > 0 ? <span class="qv-err-chip">{q.errors}</span> : <span class="dim">0</span>}
      </td>
    </tr>
  );
}

const BUCKET_LABEL: Record<StatusBucket, string> = {
  "2xx": "2xx",
  "3xx": "3xx",
  "4xx": "4xx",
  "5xx": "5xx",
  error: "failed",
};

/** Statuses as dots + counts (severity colours stay on dots, plan 3.10). */
function StatusDots({ statuses }: { statuses: Record<string, number> }) {
  const h = statusHistogram(statuses);
  const parts = STATUS_BUCKETS.filter((b) => h[b] > 0);
  if (parts.length === 0) return null;
  return (
    <span class="qv-statuses">
      {parts.map((b) => (
        <span key={b} class="qv-status" title={`${BUCKET_LABEL[b]}: ${h[b]}`}>
          <span class={`qv-sdot st-${b}`} aria-hidden="true" />
          {BUCKET_LABEL[b]} {h[b]}
        </span>
      ))}
    </span>
  );
}

function hostName(host: string): ComponentChildren {
  return host || <span class="dim">(this app, relative URL)</span>;
}

function HostFacts({ h }: { h: HostStat }) {
  return (
    <span class="qv-host-facts mono">
      <span>{h.calls} calls</span>
      <span>p95 {fmtMs(h.p95Ms)}</span>
      {h.errorPct > 0 && <span class="qv-err-chip">{fmtPct(h.errorPct)} failed</span>}
      <span title="GETs that asked for Next's data cache (force-cache, revalidate > 0). Request-side intent, not an observed hit.">
        cached {fmtPct(h.cachedPct)}
      </span>
      <StatusDots statuses={h.statuses} />
    </span>
  );
}

function HostRow({ g }: { g: HostGroup }) {
  return (
    <tr class="qv-host-row">
      <th scope="rowgroup" colSpan={COLS}>
        <span class="qv-host-name mono">{hostName(g.host)}</span>
        {g.stat ? <HostFacts h={g.stat} /> : <span class="dim">no host totals</span>}
        {g.shapes.length === 0 && <span class="dim"> · no shape in this list</span>}
      </th>
    </tr>
  );
}

/* =================================================================== subject */

function ShapeSubject({ shapeKey }: { shapeKey: string }) {
  const data = queriesData.value;
  const state = queriesState.value;
  const q = data ? findShape(data.queries, shapeKey) : undefined;
  const rows = shownShapes.value.rows;
  const i = q ? rows.findIndex((x) => x.fingerprint === q.fingerprint) : -1;
  const prev = i > 0 ? rows[i - 1] : undefined;
  const next = i >= 0 ? rows[i + 1] : undefined;

  return (
    <div class="subject">
      <div class="subject-bar">
        <span class="subject-kind">Query shape</span>
        <span class="subject-nav">
          <button
            type="button"
            class="sbtn"
            disabled={!prev}
            onClick={() => prev && selectShape(prev.fingerprint, { replace: true })}
            title="Previous shape in the list (k)"
            aria-label="Previous shape"
          >
            ‹
          </button>
          <button
            type="button"
            class="sbtn"
            disabled={!next}
            onClick={() => next && selectShape(next.fingerprint, { replace: true })}
            title="Next shape in the list (j)"
            aria-label="Next shape"
          >
            ›
          </button>
        </span>
        <button
          type="button"
          class="source-close subject-close"
          onClick={closeShape}
          aria-label="Close"
          title="Close (the list takes the full width)"
        >
          ×
        </button>
      </div>
      {q ? (
        <ShapeDetail q={q} hosts={data?.hosts ?? []} />
      ) : !data && (state === "loading" || state === "idle") ? (
        <div class="subject-loading">
          <Skeleton lines={6} />
        </div>
      ) : (
        <div class="subject-body">
          <p class="subject-lead">
            This shape isn't in the current snapshot: it was reset by Clear, or pushed out by newer shapes.
          </p>
          <pre class="qv-full mono">{shapeKey.replace(/^[a-z]+:/, "")}</pre>
        </div>
      )}
    </div>
  );
}

function shortFile(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : file;
}

function CallerLink({ c }: { c: QueryStat["callers"][number] }) {
  const loc = c.location;
  if (!loc) return <span class="mono">{c.fn ?? "(anonymous)"}</span>;
  return (
    <button
      type="button"
      class="stack-link mono"
      onClick={() => openSourceAt(loc.file, loc.line)}
      title={`${loc.file}:${loc.line} · open in the source viewer`}
    >
      {c.fn ? `${c.fn} ` : ""}
      {shortFile(loc.file)}:{loc.line}
    </button>
  );
}

/** "GET /api/x" -> the Requests query for that route. */
function routeQuery(routeKey: string): string {
  const sp = routeKey.indexOf(" ");
  return sp > 0
    ? `method:${routeKey.slice(0, sp)} route:${quoteValue(routeKey.slice(sp + 1))}`
    : `route:${quoteValue(routeKey)}`;
}

function kindLabel(q: QueryStat): string {
  if (q.kind === "fetch") return "fetch";
  if (q.system) return q.system;
  return q.kind === "db" ? "SQL" : "cache";
}

function ShapeDetail({ q, hosts }: { q: QueryStat; hosts: readonly HostStat[] }) {
  const per = perRequest(q);
  const loop = per > LOOP_PER_REQ;
  const host = q.kind === "fetch" ? hostOfShape(q.shape) : undefined;
  const hostStat = host !== undefined ? hosts.find((h) => h.host === host) : undefined;
  const byId = new Map<string, TraceSummary>();
  for (const t of tracesState.value) byId.set(t.id, t);
  const routeKeys = q.routes.map((r) => r.route);

  return (
    <div class="subject-body qv-subject">
      <h2 class="subject-title qv-subject-title">
        <span class={`qv-kind qv-kind-${q.kind}`}>{kindLabel(q)}</span>
        {host !== undefined && <span class="mono qv-subject-host">{hostName(host)}</span>}
      </h2>
      <pre class="qv-full mono">{q.shape}</pre>
      <p class="subject-lead">
        {q.calls} call{q.calls === 1 ? "" : "s"} from {q.traces} request{q.traces === 1 ? "" : "s"}
        {q.timedCalls > 0 && (
          <>
            {" "}
            · total <b class="mono">{fmtMs(q.totalMs)}</b> · p95 <b class="mono">{fmtMs(q.p95Ms)}</b> · max{" "}
            <b class="mono">{fmtMs(q.maxMs)}</b>
          </>
        )}
        {q.errors > 0 && (
          <>
            {" "}
            · <span class="qv-err-chip">{q.errors} failed</span>
          </>
        )}
      </p>

      {loop && (
        <div class="qv-callout">
          <span>
            Runs <b class="mono">×{fmtPerRequest(per)}</b> per request: most likely a loop (N+1).
          </span>
          <span class="qv-callout-actions">
            <button
              type="button"
              class="sbtn"
              onClick={() => prefillQuery(findingQuery("n-plus-1", routeKeys.length === 1 ? routeKeys : []))}
              title="List the requests with an N+1 finding"
            >
              Requests with N+1
            </button>
            {q.traceIds[0] && (
              <button
                type="button"
                class="sbtn"
                onClick={() => void loadTrace(q.traceIds[0] as string, "user")}
                title="Open the newest request that made these calls"
              >
                Open newest
              </button>
            )}
          </span>
        </div>
      )}

      <dl class="qv-facts mono">
        <dt>avg</dt>
        <dd>{fmtMs(q.avgMs)}</dd>
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

      {hostStat && (
        <p class="qv-host-line">
          <span class="dim">Host</span> <HostFacts h={hostStat} />
        </p>
      )}

      <div class="qv-cols">
        <div>
          <h3 class="qv-h">Callers</h3>
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
          <h3 class="qv-h">Routes</h3>
          <ul class="qv-ul">
            {q.routes.map((r) => (
              <li key={r.route}>
                <button
                  type="button"
                  class="link-btn mono"
                  onClick={() => prefillQuery(routeQuery(r.route))}
                  title="List this route's requests"
                >
                  {r.route}
                </button>{" "}
                <span class="dim mono">×{r.calls}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 class="qv-h">Sample requests</h3>
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
                          <span class="mono qv-sample-path">{t.url}</span>
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
