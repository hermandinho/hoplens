import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { findingQuery, quoteValue } from "../state/querySuggest";
import { prefillQuery } from "../state/requestLog";
import { serverStats, serverStatsState } from "../state/serverStats";
import { openSourceAt } from "../state/source";
import {
  type FindingGroup,
  RULE_LABELS,
  type RouteSort,
  type RouteStats,
  fmtMs,
  fmtPct,
  sortRouteStats,
} from "../state/stats";
import {
  findingGroups,
  includeCold,
  kpis,
  loadStatus,
  loadTrace,
  routeStats,
  sparks,
  statsSource,
  toggleIncludeCold,
} from "../state/store";
import { BucketLegend, MixBar, Pctl, SevBadge, Sparkline } from "./Charts";

const routeSort = signal<RouteSort>("p95");
const showAllFindings = signal(false);
const FINDINGS_PREVIEW = 8;

/** Cross-request landing view: KPIs, grouped findings, per-route table. All client-side. */
export function Overview() {
  const k = kpis.value;
  const cold = includeCold.value;
  const status = loadStatus.value;
  const sp = sparks.value;
  const pLabel = cold ? "all" : "warm";

  return (
    <section class="overview" aria-labelledby="overview-title">
      <header class="ov-head">
        <div>
          <h2 id="overview-title" class="ov-title">
            Overview
          </h2>
          <div class="ov-sub dim">
            <SourceNote requests={k.requests} />
          </div>
        </div>
        <div class="ov-head-tools">
          <button
            type="button"
            class={`chip ${cold ? "chip-active" : ""}`}
            aria-pressed={cold}
            onClick={toggleIncludeCold}
            title="Cold = first request after a rebuild, or one that waited on a dev compile. Excluded from percentiles by default."
          >
            Include cold{k.coldExcluded > 0 && !cold ? ` (${k.coldExcluded})` : ""}
          </button>
        </div>
      </header>

      {k.requests === 0 ? (
        <div class="ov-empty">
          <b>{status === "loading" ? "Loading…" : "No traffic yet"}</b>
          Use your app, or pick a route in the sidebar and send a request. Each finished request feeds the numbers here:
          latency percentiles, where the time went, and problems Hoplens spotted.
        </div>
      ) : (
        <>
          <div class="kpi-grid">
            <Kpi
              label="Requests"
              value={String(k.requests)}
              sub={k.coldExcluded ? `${k.coldExcluded} cold` : undefined}
            >
              <Sparkline values={sp.requests} label="Requests over time" />
            </Kpi>
            <Kpi
              label={`${pLabel} p50`}
              value={<Pctl value={k.latency.p50} n={k.latency.n} />}
              sub={`n=${k.latency.n}`}
            >
              <Sparkline values={sp.p50} label="p50 over time" />
            </Kpi>
            <Kpi
              label={`${pLabel} p95`}
              value={<Pctl value={k.latency.p95} n={k.latency.n} />}
              sub={`n=${k.latency.n}`}
            >
              <Sparkline values={sp.p95} label="p95 over time" />
            </Kpi>
            <Kpi
              label="Errors"
              value={fmtPct(k.errPct)}
              tone={k.errors > 0 ? "err" : undefined}
              sub={`${k.errors} of ${k.requests} returned 5xx`}
            >
              <Sparkline values={sp.errPct} label="Error rate over time" tone="err" />
            </Kpi>
            <Kpi
              label="Open findings"
              value={String(k.openFindings)}
              tone={k.openFindings > 0 ? "warn" : undefined}
              sub={k.newFindings > 0 ? `${k.newFindings} new since last rebuild` : "distinct problems"}
            />
            <Kpi
              label="Queries + fetches / req"
              value={k.avgIo === undefined ? "—" : k.avgIo.toFixed(1)}
              sub="db + cache + external"
            >
              <Sparkline values={sp.io} label="I/O calls per request over time" />
            </Kpi>
          </div>

          <NeedsAttention groups={findingGroups.value} />
          <RoutesTable rows={routeStats.value} />
        </>
      )}
    </section>
  );
}

/** Where the numbers come from, honestly: server aggregates or this tab's retained summaries. */
function SourceNote({ requests }: { requests: number }) {
  const plural = requests === 1 ? "" : "s";
  if (statsSource.value === "server") {
    const since = serverStats.value?.since;
    return (
      <span title="GET /api/stats: kept per route and per dev-rebuild epoch on the server, so evicted requests still count. Cold requests are excluded.">
        {requests} request{plural}
        {since ? ` since ${new Date(since).toLocaleTimeString()}` : ""} · server stats, survive eviction · findings and
        sparklines from the retained requests
      </span>
    );
  }
  if (requests === 0) return <>Stats across every retained request</>;
  const why = includeCold.value
    ? "cold included, so computed in this tab"
    : serverStatsState.value === "unavailable"
      ? "computed in this tab (this runtime has no /api/stats)"
      : "computed in this tab";
  return (
    <>
      {requests} retained request{plural} · {why}
    </>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
  children,
}: {
  label: string;
  value: ComponentChildren;
  sub?: string;
  tone?: "err" | "warn";
  children?: ComponentChildren;
}) {
  return (
    <div class={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <div class="kpi-label">{label}</div>
      <div class="kpi-value mono">{value}</div>
      {sub && <div class="kpi-sub dim mono">{sub}</div>}
      {children && <div class="kpi-spark">{children}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- findings */

function NeedsAttention({ groups }: { groups: FindingGroup[] }) {
  const all = showAllFindings.value;
  const visible = all ? groups : groups.slice(0, FINDINGS_PREVIEW);
  return (
    <section class="ov-section" aria-labelledby="ov-attn-title">
      <div class="ov-section-head">
        <h3 id="ov-attn-title" class="ov-section-title">
          Needs attention {groups.length > 0 && <span class="count">{groups.length}</span>}
        </h3>
      </div>
      {groups.length === 0 ? (
        <div class="muted">Nothing flagged across the retained requests.</div>
      ) : (
        <ul class="attn-list">
          {visible.map((g) => (
            <FindingRow key={g.fingerprint} g={g} />
          ))}
        </ul>
      )}
      {groups.length > FINDINGS_PREVIEW && (
        <button type="button" class="ov-more" onClick={() => (showAllFindings.value = !all)}>
          {all ? "Show fewer" : `Show all ${groups.length}`}
        </button>
      )}
    </section>
  );
}

function FindingRow({ g }: { g: FindingGroup }) {
  const loc = g.location;
  return (
    <li class={`attn-row sev-row-${g.severity}`}>
      <button
        type="button"
        class="attn-main"
        onClick={() => void loadTrace(g.latestTraceId, "user")}
        title="Open the most recent request with this finding"
      >
        <span class={`sev-dot sev-${g.severity}`} aria-label={g.severity} />
        <span class="attn-title">{g.title}</span>
        <span class="attn-meta mono dim">
          <span class="attn-rule">{RULE_LABELS[g.rule] ?? g.rule}</span>
          {g.fn && <span>{g.fn}</span>}
          <span>
            {g.requests} req{g.requests === 1 ? "" : "s"}
          </span>
          {g.routes.length > 1 && <span>{g.routes.length} routes</span>}
          {g.worstSavedMs !== undefined && g.worstSavedMs >= 1 && (
            <span class="attn-save">~{fmtMs(g.worstSavedMs)} saveable</span>
          )}
          {g.isNew && <span class="attn-new">new</span>}
        </span>
      </button>
      <button
        type="button"
        class="link-btn attn-filter"
        onClick={() => prefillQuery(findingQuery(g.rule, g.routes))}
        title={`List every request with this finding${g.routes.length === 1 ? " on this route" : ""} in the request log`}
        aria-label={`List requests with ${RULE_LABELS[g.rule] ?? g.rule}${g.routes.length === 1 ? ` on ${g.routes[0]}` : ""}`}
      >
        filter
      </button>
      {loc && (
        <button
          type="button"
          class="stack-link mono attn-loc"
          onClick={() => openSourceAt(loc.file, loc.line)}
          title="Open in source viewer"
        >
          {shortFile(loc.file)}:{loc.line}
        </button>
      )}
    </li>
  );
}

function shortFile(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : file;
}

/* ----------------------------------------------------------------- routes */

const SORTS: Array<{ id: RouteSort; label: string }> = [
  { id: "p95", label: "Slowest p95" },
  { id: "hits", label: "Most hits" },
  { id: "errors", label: "Most errors" },
];

function RoutesTable({ rows }: { rows: RouteStats[] }) {
  const by = routeSort.value;
  const sorted = sortRouteStats(rows, by);
  return (
    <section class="ov-section" aria-labelledby="ov-routes-title">
      <div class="ov-section-head">
        <h3 id="ov-routes-title" class="ov-section-title">
          Routes <span class="count">{rows.length}</span>
        </h3>
        <fieldset class="chips ov-sort">
          <legend class="sr-only">Sort routes</legend>
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              class={`chip ${by === s.id ? "chip-active" : ""}`}
              aria-pressed={by === s.id}
              onClick={() => (routeSort.value = s.id)}
            >
              {s.label}
            </button>
          ))}
        </fieldset>
      </div>
      <BucketLegend />
      <div class="ov-table-wrap">
        <table class="ov-table">
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col" class="num">
                Hits
              </th>
              <th scope="col" class="num">
                Err
              </th>
              <th scope="col" class="num">
                p50
              </th>
              <th scope="col" class="num">
                p95
              </th>
              <th scope="col" class="num" title="Samples behind the percentiles">
                n
              </th>
              <th scope="col">Time mix</th>
              <th scope="col" class="num" title="db + cache + external calls per request">
                I/O/req
              </th>
              <th scope="col" class="num">
                Findings
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key} class="ov-row">
                <th scope="row" class="ov-route">
                  <button
                    type="button"
                    class="ov-route-btn"
                    onClick={() =>
                      r.lastTraceId
                        ? void loadTrace(r.lastTraceId, "user")
                        : prefillQuery(`method:${r.method} route:${quoteValue(r.route)}`)
                    }
                    title={
                      r.lastTraceId
                        ? "Open the most recent request to this route"
                        : "Its requests were evicted: list any still retained in the request log"
                    }
                  >
                    <span class={`method-tag m-${r.method}`}>{r.method}</span>
                    <span class="mono ov-route-path">{r.route}</span>
                  </button>
                </th>
                <td class="num mono">{r.hits}</td>
                <td class={`num mono ${r.errors > 0 ? "ov-err" : "dim"}`}>{fmtPct(r.errPct)}</td>
                <td class="num">
                  <Pctl value={r.latency.p50} n={r.latency.n} />
                </td>
                <td class="num">
                  <Pctl value={r.latency.p95} n={r.latency.n} />
                </td>
                <td class={`num mono ${r.latency.n < 10 ? "dim" : ""}`}>{r.latency.n}</td>
                <td class="ov-mix">
                  <MixBar time={r.mix} />
                </td>
                <td class="num mono">{r.avgIo === undefined ? "—" : r.avgIo.toFixed(1)}</td>
                <td class="num">
                  {r.findings > 0 ? (
                    <SevBadge severity={r.worstSeverity} count={r.findings} />
                  ) : (
                    <span class="dim">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
