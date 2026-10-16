import { type Signal, computed, signal } from "@preact/signals";
import type { ComponentType } from "preact";
import type { FindingRollup } from "../api/types";
import { culpritLoc } from "../state/callSite";
import { openErrorsPanel, processErrorTotal } from "../state/health";
import { register } from "../state/keymap";
import { findingQuery, quoteValue } from "../state/querySuggest";
import { prefillQuery } from "../state/requestLog";
import { go, route } from "../state/router";
import { serverErrorTally, serverStats, serverStatsState } from "../state/serverStats";
import { openSourceAt } from "../state/source";
import {
  ERROR_QUERIES,
  type ErrorTally,
  type Exemplars,
  type FindingGroup,
  type Hero,
  RULE_LABELS,
  type RouteSort,
  type RouteStats,
  deltaLabel,
  errorQueryFor,
  errorTally,
  fmtMs,
  holdOrder,
  isLowSignal,
  overviewHero,
  routeExemplars,
  routeKeyOf,
  routeOfKey,
  sortRouteStats,
  statusClass,
} from "../state/stats";
import {
  finishedTraces,
  includeCold,
  kpis,
  loadStatus,
  loadTrace,
  overviewFindings,
  retainedIds,
  routeStats,
  statsSource,
  toggleIncludeCold,
  tracesState,
} from "../state/store";
import { findingSentence, shortLoc } from "../state/verdict";
import { MixBar, Pctl, SevBadge } from "./Charts";

/*
 * Overview (plan 3.3): cause first. One hero sentence (the #1 repeatable finding by impact), a slot
 * for the "since your last edit" strip, the findings ranked by saveable ms x requests with "seen once"
 * and n= labels, the routes by time spent with a d-epoch column, and one honest errors line.
 * Selecting a route opens it as the subject (#/route/<key>): p50, time split, its findings and
 * fast / typical / slow example requests, one click each.
 * Rows never re-sort under the pointer or while focus is inside the list (plan 3.1 #5).
 */

const routeSort = signal<RouteSort>("time");
const showAllFindings = signal(false);
const FINDINGS_PREVIEW = 6;

/**
 * The "since your last edit" strip (WP9b): set this to a component and the Overview draws it between
 * the hero and the lists. Null = nothing drawn (no empty band).
 */
export const sinceStripSlot: Signal<ComponentType | null> = signal(null);

/** Errors line: server totals when they carry the split, else this tab's retained requests. */
export const overviewErrors = computed<ErrorTally>(() => {
  const s = serverStats.value;
  if (statsSource.value === "server" && s) {
    const t = serverErrorTally(s);
    if (t) return t;
  }
  return errorTally(finishedTraces.value);
});

/**
 * Hold the on-screen order (plan 3.1 #5, 3.8): the shell's Split sets this while the pointer is over
 * the Overview or focus is inside the route subject. Counts keep updating in place; rows that are new
 * while held go to the end; the order catches up when the hold ends.
 */
export const overviewHeld = signal(false);

export function Overview() {
  const k = kpis.value;
  const cold = includeCold.value;
  const status = loadStatus.value;
  const findings = overviewFindings.value;
  const errors = overviewErrors.value;
  const routes = routeStats.value;
  const hero = overviewHero(findings, routes, errors, k.requests);
  const Strip = sinceStripSlot.value;

  return (
    <section class="overview" aria-labelledby="overview-title">
      <header class="ov-head">
        <h2 id="overview-title" class="ov-title">
          Overview
        </h2>
        <span class="ov-sub dim">
          <SourceNote requests={k.requests} />
        </span>
        <button
          type="button"
          class={`chip ov-cold ${cold ? "chip-active" : ""}`}
          aria-pressed={cold}
          onClick={toggleIncludeCold}
          title="Cold = first request after a rebuild, or one that waited on a dev compile. Excluded from percentiles by default."
        >
          Include cold{k.coldExcluded > 0 && !cold ? ` (${k.coldExcluded})` : ""}
        </button>
      </header>

      {k.requests === 0 ? (
        <div class="ov-empty">
          <b>{status === "loading" ? "Loading…" : "No traffic yet"}</b>
          Use your app, or open Requests and send one. Each finished request feeds this page: the problem worth fixing
          first, where the time went per route, and what changed since your last edit.
        </div>
      ) : (
        <>
          <HeroBlock hero={hero} />
          {Strip && (
            <div class="ov-since">
              <Strip />
            </div>
          )}
          <div class="ov-cols">
            <NextFindings groups={findings} hero={hero.finding?.fingerprint} />
            <RoutesTable rows={routes} errors={errors} />
          </div>
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
      <span title="GET /api/stats: kept per route and per dev-rebuild epoch on the server, so evicted requests still count. Cold requests are out of the percentiles.">
        {requests} request{plural}
        {since ? ` since ${new Date(since).toLocaleTimeString()}` : ""} · server stats
      </span>
    );
  }
  if (requests === 0) return <>Stats across every retained request</>;
  const why = includeCold.value
    ? "cold included, computed in this tab"
    : serverStatsState.value === "unavailable"
      ? "computed in this tab (no /api/stats)"
      : "computed in this tab";
  return (
    <>
      {requests} retained request{plural} · {why}
    </>
  );
}

/* -------------------------------------------------------------------- hero */

function routesPhrase(keys: readonly string[]): string {
  if (keys.length === 1) return routeOfKey(keys[0] as string);
  return `${keys.length} routes`;
}

/** "~173ms per request x 9 requests = 1.6s" (or the per-request part alone for one request). */
function savingPhrase(g: FindingGroup): string | undefined {
  if (g.savedMsPerRequest === undefined || g.savedMsPerRequest < 1) return undefined;
  const per = `~${fmtMs(g.savedMsPerRequest)}`;
  if (g.requests <= 1) return `${per} saveable in 1 request (seen once)`;
  return `${per} saveable per request × ${g.requests} requests = ${fmtMs(g.impactMs)} total`;
}

function HeroBlock({ hero }: { hero: Hero }) {
  if (hero.kind === "finding" && hero.finding) {
    const g = hero.finding;
    const verb = hero.routes.length > 1 ? "are" : "is";
    const sentence = findingSentence({ rule: g.rule, title: g.title, fn: g.fn, count: g.maxCount });
    const save = savingPhrase(g);
    return (
      <section class={`ov-hero ov-hero-${g.severity}`} aria-label="Top problem">
        <p class="ov-hero-text t-hero">
          {routesPhrase(hero.routes)} {verb} slow because {sentence}.
        </p>
        <div class="ov-hero-sub">
          {save && <span class="mono">{save}</span>}
          <FindingLoc g={g} />
          <FindingActions g={g} primary />
        </div>
      </section>
    );
  }
  if (hero.kind === "errors" && hero.errors) {
    const e = hero.errors;
    const parts: string[] = [];
    if (e.fivexx) parts.push(`${e.fivexx} answered 5xx`);
    if (e.thrown) parts.push(`${e.thrown} threw`);
    if (e.swallowed) parts.push(`${e.swallowed} swallowed an error but answered below 500`);
    return (
      <section class="ov-hero ov-hero-error" aria-label="Top problem">
        <p class="ov-hero-text t-hero">
          {e.total} of {hero.requests} request{hero.requests === 1 ? "" : "s"} went wrong: {parts.join(", ")}.
        </p>
        <div class="ov-hero-sub">
          <span class="dim">No repeatable slowness worth fixing was found.</span>
          <button type="button" class="link-btn" onClick={() => prefillQuery(errorQueryFor(e))}>
            List the {e.swallowed >= e.fivexx + e.thrown ? "swallowed ones" : "failed ones"}
          </button>
        </div>
      </section>
    );
  }
  const s = hero.slowest;
  return (
    <section class="ov-hero ov-hero-ok" aria-label="Summary">
      <p class="ov-hero-text t-hero">
        No {hero.seenOnce > 0 ? "repeatable " : ""}problems found in {hero.requests} request
        {hero.requests === 1 ? "" : "s"}.
        {s && (
          <>
            {" "}
            Slowest route: {routeOfKey(s.key)} (p50 <Pctl value={s.p50} n={s.n} />
            ).
          </>
        )}
      </p>
      {hero.seenOnce > 0 && (
        <div class="ov-hero-sub dim">
          {hero.seenOnce} finding{hero.seenOnce === 1 ? "" : "s"} seen once or caused by the dev compile, listed below.
        </div>
      )}
    </section>
  );
}

/** The finding's culprit line (an N+1's loop call, as the trace verdict marks it), as a source link. */
function FindingLoc({ g }: { g: FindingGroup }) {
  const loc = culpritLoc(g);
  return loc ? <LocButton loc={loc} /> : null;
}

function LocButton({ loc }: { loc: { file: string; line: number; column?: number } }) {
  return (
    <button
      type="button"
      class="stack-link mono ov-loc"
      onClick={() => openSourceAt(loc.file, loc.line)}
      title={`Open ${loc.file}:${loc.line} in the source viewer`}
    >
      {shortLoc(loc)}
    </button>
  );
}

function FindingActions({ g, primary = false }: { g: FindingGroup; primary?: boolean }) {
  const label = RULE_LABELS[g.rule] ?? g.rule;
  return (
    <span class="ov-actions">
      <button
        type="button"
        class={primary ? "action ov-open" : "link-btn"}
        disabled={!g.latestTraceId}
        onClick={() => g.latestTraceId && void loadTrace(g.latestTraceId, "user")}
        title={
          g.latestTraceId
            ? "Open the most recent request with this finding"
            : "Every request with this finding left the buffer; filter shows any still retained"
        }
      >
        open example
      </button>
      <button
        type="button"
        class="link-btn"
        onClick={() => prefillQuery(findingQuery(g.rule, g.routes))}
        title={`List every request with this finding${g.routes.length === 1 ? " on this route" : ""} in the request log`}
        aria-label={`List requests with ${label}${g.routes.length === 1 ? ` on ${g.routes[0]}` : ""}`}
      >
        filter
      </button>
    </span>
  );
}

/* ---------------------------------------------------------------- findings */

const prevFindingOrder = { keys: null as string[] | null };

function NextFindings({ groups, hero }: { groups: FindingGroup[]; hero?: string }) {
  const held = overviewHeld.value;
  const ordered = held ? holdOrder(prevFindingOrder.keys, groups, (g) => g.fingerprint) : groups;
  prevFindingOrder.keys = ordered.map((g) => g.fingerprint);
  const repeat = ordered.filter((g) => !isLowSignal(g) && g.fingerprint !== hero);
  const once = ordered.filter(isLowSignal);
  const all = showAllFindings.value;
  const visible = all ? repeat : repeat.slice(0, FINDINGS_PREVIEW);
  const total = groups.length;

  return (
    <section class="ov-section ov-next" aria-labelledby="ov-next-title">
      <div class="ov-section-head">
        <h3 id="ov-next-title" class="ov-section-title">
          Next {total > 0 && <span class="count">{total}</span>}
        </h3>
        <span class="ov-hint dim" title="Ranked by saveable ms per request × requests that had it">
          impact = saveable × requests
        </span>
      </div>
      {total === 0 ? (
        <div class="muted">Nothing flagged across the requests seen.</div>
      ) : (
        <>
          {visible.length > 0 ? (
            <ol class="ov-list">
              {visible.map((g) => (
                <FindingRow key={g.fingerprint} g={g} />
              ))}
            </ol>
          ) : (
            hero && <div class="muted">Only the problem above repeats.</div>
          )}
          {repeat.length > FINDINGS_PREVIEW && (
            <button type="button" class="ov-more" onClick={() => (showAllFindings.value = !all)}>
              {all ? "Show fewer" : `Show all ${repeat.length}`}
            </button>
          )}
          {once.length > 0 && (
            <details class="ov-once">
              <summary>
                Seen once or dev compile <span class="count">{once.length}</span>
                <span class="dim"> · ranked after the rest</span>
              </summary>
              <ol class="ov-list">
                {once.map((g) => (
                  <FindingRow key={g.fingerprint} g={g} />
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function FindingRow({ g }: { g: FindingGroup }) {
  const sentence = findingSentence({ rule: g.rule, title: g.title, fn: g.fn, count: g.maxCount });
  const per = g.savedMsPerRequest !== undefined && g.savedMsPerRequest >= 1 ? g.savedMsPerRequest : undefined;
  return (
    <li class={`ov-find ov-find-${g.severity} ${isLowSignal(g) ? "ov-find-once" : ""}`}>
      <span class={`sev-dot sev-${g.severity}`} role="img" aria-label={g.severity} />
      <div class="ov-find-body">
        <div class="ov-find-text" title={g.title}>
          {sentence}
        </div>
        <div class="ov-find-meta">
          <span class="ov-find-route mono" title={g.routes.join(", ")}>
            {routesPhrase(g.routes)}
          </span>
          {per !== undefined &&
            (g.seenOnce ? (
              <span class="mono" title="Estimated saving in the one request that had it">
                ~{fmtMs(per)} in 1 request
              </span>
            ) : (
              <span
                class="mono"
                title={`~${fmtMs(per)} saveable per request (mean estimate) × ${g.requests} requests = ${fmtMs(g.impactMs)} in total`}
              >
                ~{fmtMs(per)}/req × {g.requests} = {fmtMs(g.impactMs)}
              </span>
            ))}
          {g.rule === "cold-compile" && (
            <span class="ov-once-tag" title="Time the dev server spent compiling: not something the code saves">
              likely dev compile
            </span>
          )}
          {g.seenOnce ? (
            <span class="ov-once-tag">seen once</span>
          ) : (
            <span class="mono dim" title="Requests that had this finding">
              n={g.requests}
            </span>
          )}
          {g.isNew && <span class="ov-new">new since last rebuild</span>}
          <FindingLoc g={g} />
          <FindingActions g={g} />
        </div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ routes */

const SORTS: Array<{ id: RouteSort; label: string; title: string }> = [
  { id: "time", label: "Time spent", title: "Summed duration: where the server spent its time" },
  { id: "p95", label: "Slowest", title: "Slowest p95 first" },
  { id: "errors", label: "Errors", title: "Most failed requests first" },
];

const prevRouteOrder = { keys: null as string[] | null, sort: "time" as RouteSort };
/** Routes in the order on screen, for j/k. */
let routeOrderOnScreen: string[] = [];

function RoutesTable({ rows, errors }: { rows: RouteStats[]; errors: ErrorTally }) {
  const by = routeSort.value;
  const sorted = sortRouteStats(rows, by);
  const held = overviewHeld.value;
  // A sort picked while held is the reader's own move: apply it.
  const ordered = held && prevRouteOrder.sort === by ? holdOrder(prevRouteOrder.keys, sorted, (r) => r.key) : sorted;
  prevRouteOrder.keys = ordered.map((r) => r.key);
  prevRouteOrder.sort = by;
  routeOrderOnScreen = prevRouteOrder.keys;
  const r = route.value;
  const open = r.view === "overview" ? r.routeKey : undefined;
  const epoch = serverStats.value?.epoch;
  const showDelta = statsSource.value === "server" && rows.some((x) => x.delta);

  return (
    <section class="ov-section ov-routes" aria-labelledby="ov-routes-title">
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
              title={s.title}
              onClick={() => (routeSort.value = s.id)}
            >
              {s.label}
            </button>
          ))}
        </fieldset>
        <span class="ov-hint dim">
          <kbd>j</kbd> <kbd>k</kbd> move
        </span>
      </div>
      <div class="ov-table-wrap">
        <table class="ov-table">
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col" class="num" title="Requests (cold included)">
                n
              </th>
              <th scope="col" class="num" title="Median duration of warm requests">
                p50
              </th>
              <th scope="col" class="num ov-col-p95">
                p95
              </th>
              {showDelta && (
                <th
                  scope="col"
                  class="num"
                  title="p50 change in the newest dev-rebuild epoch against this route's previous one. Blank when either side has fewer than 3 warm requests."
                >
                  Δ e{epoch}
                </th>
              )}
              <th scope="col" class="ov-col-split">
                Split
              </th>
              <th scope="col" class="num ov-col-find">
                <span class="sr-only">Findings</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => (
              <tr
                key={row.key}
                class={`ov-row ${open === row.key ? "ov-row-on" : ""}`}
                aria-selected={open === row.key}
              >
                <th scope="row" class="ov-route">
                  <button
                    type="button"
                    class="ov-route-btn"
                    onClick={() => openRoute(row.key)}
                    title="Show this route: percentiles, time split, findings and example requests"
                  >
                    <span class={`method-tag m-${row.method}`}>{row.method}</span>
                    <span class="mono ov-route-path">{row.route}</span>
                  </button>
                </th>
                <td class="num mono">
                  {row.hits}
                  {row.errors > 0 && (
                    <span class="ov-err-n" title={`${row.errors} failed (5xx)`}>
                      {" "}
                      !{row.errors}
                    </span>
                  )}
                </td>
                <td class="num">
                  <Pctl value={row.latency.p50} n={row.latency.n} />
                </td>
                <td class="num ov-col-p95">
                  <Pctl value={row.latency.p95} n={row.latency.n} />
                </td>
                {showDelta && (
                  <td class="num">
                    <DeltaCell row={row} />
                  </td>
                )}
                <td class="ov-col-split">
                  <MixBar time={row.mix} />
                </td>
                <td class="num ov-col-find">
                  <SevBadge severity={row.worstSeverity} count={row.findings} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorsLine e={errors} />
    </section>
  );
}

function DeltaCell({ row }: { row: RouteStats }) {
  const d = row.delta;
  const label = deltaLabel(d);
  if (!d) return <span class="dim" title="No traffic in the newest epoch, or no earlier epoch to compare with" />;
  if (!label)
    return (
      <span
        class="dim ov-delta-blank"
        title={`Too few warm requests to compare: n ${d.nBefore} | ${d.nAfter} (needs 3 each)`}
      >
        <span class="sr-only">n too small</span>
      </span>
    );
  const tone = d.status === "regressed" ? "worse" : d.status === "improved" ? "better" : "same";
  const pct = d.deltaPct !== undefined ? ` (${d.deltaPct > 0 ? "+" : ""}${Math.round(d.deltaPct * 100)}%)` : "";
  return (
    <span
      class={`ov-delta ov-delta-${tone} ${d.lowConfidence ? "ov-delta-low" : ""} mono`}
      title={`p50 e${d.baselineEpoch} -> e${d.epoch}: ${label === "=" ? "unchanged" : `${label}ms${pct}`} · n ${d.nBefore} | ${d.nAfter}${d.lowConfidence ? " · low confidence (n < 8)" : ""}${d.basis === "variants" ? " · same URL variants on both sides" : ""}`}
    >
      {label}
    </span>
  );
}

function ErrorsLine({ e }: { e: ErrorTally }) {
  // Process errors (WP6 health) are not requests: listed after the request tally, opening their panel.
  const proc = processErrorTotal.value;
  const part = (n: number, label: string, q: string, title: string) =>
    n > 0 ? (
      <button type="button" class="link-btn mono" onClick={() => prefillQuery(q)} title={title}>
        {label} {n}
      </button>
    ) : (
      <span class="mono dim" title={title}>
        {label} 0
      </span>
    );
  return (
    <p class={`ov-errors ${e.total > 0 ? "ov-errors-on" : ""}`}>
      <span class="ov-errors-total">
        {e.total > 0 && <span class="sev-dot sev-error" aria-hidden="true" />}
        Errors <span class="mono">{e.total}</span>
      </span>
      <span class="ov-errors-parts">
        {part(e.fivexx, "5xx", ERROR_QUERIES.fivexx, "Answered 500 or above with no exception captured")}
        <span aria-hidden="true">·</span>
        {part(e.thrown, "thrown", ERROR_QUERIES.thrown, "Failed with an exception captured")}
        <span aria-hidden="true">·</span>
        {part(
          e.swallowed,
          "swallowed",
          ERROR_QUERIES.swallowed,
          "An exception was captured but the response still went out below 500 (caught and hidden)",
        )}
      </span>
      {proc > 0 && (
        <span class="ov-errors-parts">
          <span aria-hidden="true">·</span>
          <button
            type="button"
            class="link-btn mono"
            onClick={openErrorsPanel}
            title="Uncaught exceptions and unhandled rejections outside any request (process health)"
          >
            process {proc}
          </button>
        </span>
      )}
    </p>
  );
}

function openRoute(key: string, opts?: { replace?: boolean }): void {
  const since = route.peek().since;
  go(since ? { view: "overview", routeKey: key, since } : { view: "overview", routeKey: key }, opts);
}

/** j / k on the Overview: the next / previous route in the order on screen; its detail follows. */
function stepRoute(delta: number): void {
  const keys = routeOrderOnScreen;
  if (!keys.length) return;
  const r = route.peek();
  const cur = r.view === "overview" && r.routeKey ? keys.indexOf(r.routeKey) : -1;
  const next = cur < 0 ? (delta > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, cur + delta));
  const key = keys[next];
  if (key && key !== (r.view === "overview" ? r.routeKey : undefined)) openRoute(key, { replace: cur >= 0 });
}

// routeStats is read as a signal so the action bar, which asks this without a keydown, updates when
// the first routes arrive (routeOrderOnScreen is a plain variable set during render).
const onOverview = () =>
  route.value.view === "overview" && (routeOrderOnScreen.length > 0 || routeStats.value.length > 0);

// j / k on the Overview, registered on import (this module is part of the shell bundle), so the keys
// exist from the first frame and the "?" sheet lists them. List scope (the shell marks it live on the
// Overview too); `when` keeps them silent on the other lists, whose j / k are the same keys.
register("list", "j", "Next route (its detail follows)", () => stepRoute(1), { when: onOverview, hint: "move" });
register("list", "k", "Previous route (its detail follows)", () => stepRoute(-1), { when: onOverview, hint: "move" });

/* ----------------------------------------------------------- route subject */

/**
 * #/route/<key>: one route as the Overview's subject. `key` is the RouteStats key ("GET /api/feed");
 * "route::METHOD" is accepted too.
 */
export function RouteSubject({ routeKey }: { routeKey: string }) {
  const stat = routeStats.value.find((s) => s.key === routeKey || `${s.route}::${s.method}` === routeKey);
  const close = () => {
    const since = route.peek().since;
    go(since ? { view: "overview", since } : { view: "overview" });
  };

  return (
    <div class="subject">
      <div class="subject-bar">
        <span class="subject-kind">Route</span>
        <button type="button" class="source-close subject-close" onClick={close} aria-label="Close" title="Close">
          ×
        </button>
      </div>
      <div class="subject-body">
        {!stat ? (
          <p class="subject-lead">
            No requests for <code>{routeKey}</code> are retained.
          </p>
        ) : (
          <RouteDetail stat={stat} />
        )}
      </div>
    </div>
  );
}

function RouteDetail({ stat }: { stat: RouteStats }) {
  const traces = tracesState.value;
  const findings = overviewFindings.value.filter((g) => g.routes.includes(stat.key));
  const ids = retainedIds.value;
  const cold = includeCold.value;
  const client = routeExemplars(traces, stat.key, cold);
  // Server exemplars can name evicted requests: use them only when all three are still here. They
  // are always warm-only, so with "Include cold" on the tab's own pick (cold included) wins.
  const sx = cold ? undefined : stat.exemplars;
  const ex: Exemplars | undefined =
    sx && ids.has(sx.fast.traceId) && ids.has(sx.typical.traceId) && ids.has(sx.slow.traceId) ? sx : client;
  const recent = traces.filter((t) => t.kind !== "asset" && routeKeyOf(t) === stat.key).slice(0, 8);
  const d = stat.delta;
  const dl = deltaLabel(d);

  return (
    <>
      <h2 class="subject-title mono">
        {stat.method} {stat.route}
      </h2>
      <p class="subject-lead">
        p50 <Pctl value={stat.latency.p50} n={stat.latency.n} /> · p95{" "}
        <Pctl value={stat.latency.p95} n={stat.latency.n} /> · n={stat.latency.n} warm of {stat.hits}
        {stat.errors > 0 && ` · ${stat.errors} failed`}
        {d && dl && (
          <>
            {" "}
            · since e{d.baselineEpoch}:{" "}
            <span
              class={`ov-delta mono ov-delta-${d.status === "regressed" ? "worse" : d.status === "improved" ? "better" : "same"}`}
            >
              {dl === "=" ? "unchanged" : `${dl}ms`}
            </span>
          </>
        )}
      </p>
      {stat.mix && <MixBar time={stat.mix} class="subject-mix" />}

      <section class="rs-block" aria-labelledby="rs-ex-title">
        <h3 id="rs-ex-title" class="rs-title">
          Example requests
        </h3>
        {ex ? (
          <div class="rs-ex">
            <ExemplarButton label="Fast" hint="p10" pick={ex.fast} />
            <ExemplarButton label="Typical" hint="nearest p50" pick={ex.typical} />
            <ExemplarButton label="Slow" hint="slowest" pick={ex.slow} />
          </div>
        ) : (
          <p class="muted">No warm request of this route is retained.</p>
        )}
      </section>

      <section class="rs-block" aria-labelledby="rs-find-title">
        <h3 id="rs-find-title" class="rs-title">
          Findings {findings.length > 0 && <span class="count">{findings.length}</span>}
        </h3>
        {findings.length === 0 ? (
          <p class="muted">Nothing flagged on this route.</p>
        ) : (
          <ol class="ov-list">
            {findings.map((g) => (
              <FindingRow key={g.fingerprint} g={g} />
            ))}
          </ol>
        )}
      </section>

      {recent.length > 0 && (
        <section class="rs-block" aria-labelledby="rs-recent-title">
          <h3 id="rs-recent-title" class="rs-title">
            Recent
          </h3>
          <ul class="subject-recent">
            {recent.map((t) => (
              <li key={t.id}>
                <button type="button" class="subject-recent-row" onClick={() => void loadTrace(t.id, "user")}>
                  <span class="mono dim">{new Date(t.startedAt).toLocaleTimeString()}</span>
                  <span class="mono subject-recent-url">{t.url}</span>
                  <span class={`status-code ${statusClass(t)}`}>{t.status ?? (t.error ? "ERR" : "…")}</span>
                  <span class="mono">{fmtMs(t.duration)}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            class="link-btn rs-all"
            onClick={() => prefillQuery(`method:${stat.method} route:${quoteValue(stat.route)}`)}
          >
            All requests to this route
          </button>
        </section>
      )}
    </>
  );
}

function ExemplarButton({ label, hint, pick }: { label: string; hint: string; pick: { traceId: string; ms: number } }) {
  return (
    <button
      type="button"
      class="rs-ex-btn"
      onClick={() => void loadTrace(pick.traceId, "user")}
      title={`Open the ${label.toLowerCase()} request (${hint})`}
    >
      <span class="rs-ex-label">{label}</span>
      <span class="mono">{fmtMs(pick.ms)}</span>
    </button>
  );
}
