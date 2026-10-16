import { useComputed, useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { TraceSummary } from "../api/types";
import { logQuery, logRows } from "../state/requestLog";
import { type Route, route, setSince } from "../state/router";
import { fmtMs, routeKeyOf } from "../state/stats";
import {
  builderOpen,
  closeBuilder,
  closeSubject,
  liveHold,
  loadTrace,
  routesState,
  selectRoute,
  selectedRouteKey,
  selectedTrace,
  selectedTraceId,
  tracesState,
} from "../state/store";
import { Details } from "./Details";
import { Inspector } from "./Inspector";
import { JourneyPane } from "./JourneyPane";
import { Overview, RouteSubject, overviewHeld } from "./Overview";
import { QueriesView } from "./QueriesView";
import { RequestBuilder } from "./RequestBuilder";
import { RequestLog } from "./RequestLog";
import { Skeleton } from "./Skeleton";
import { Split } from "./Split";
import { TraceHeader } from "./TraceHeader";

/*
 * The main area: every view is the same list | subject split (plan 3.8), driven by the route.
 *   Overview   overview          | route subject (#/route/<key>)
 *   Requests   live request log  | the open request (#/r/<id>), the builder drawer, compare
 *   Queries    query shapes      | the open shape (#/q/<fingerprint>); QueriesView owns its Split
 *   Changes    edits seen so far (full width; WP9b draws the timeline)
 * A pane with nothing to show is not drawn: no subject means the list takes the full width.
 * Each view's Split is keyed by its id, so a view switch remounts it: the width is read per view and
 * the unmount releases the live hold (a pointer left on the old list must not pause Follow).
 */

export function MainPane() {
  const r = route.value;
  switch (r.view) {
    case "overview":
      return (
        <main id="main" class="main" aria-label="Overview">
          <Split
            key="overview"
            id="overview"
            list={<Overview />}
            listLabel="Overview"
            subject={r.routeKey ? <RouteSubject routeKey={r.routeKey} /> : null}
            subjectLabel="Route"
            listClass="split-scroll"
            subjectClass="split-scroll"
            onHold={(held) => {
              overviewHeld.value = held;
            }}
          />
        </main>
      );
    case "queries":
      return (
        <main id="main" class="main" aria-label="Queries and hosts">
          <QueriesView />
        </main>
      );
    case "changes":
      return (
        <main id="main" class="main" aria-label="Changes">
          <Split key="changes" id="changes" list={<ChangesList r={r} />} listLabel="Changes" listClass="split-scroll" />
        </main>
      );
    default: {
      const hasSubject = r.view === "trace" || r.view === "compare" || builderOpen.value;
      return (
        <main id="main" class="main" aria-label="Requests">
          <Split
            key="requests"
            id="requests"
            list={<RequestsList />}
            listLabel="Requests"
            subject={hasSubject ? <RequestSubject r={r} /> : null}
            subjectLabel="Request"
            listClass="split-log"
            subjectClass="split-scroll"
            onHold={(held) => {
              liveHold.value = held;
            }}
          />
        </main>
      );
    }
  }
}

/* ================================================================ requests list */

/** Row height of the dense log (RequestLog ROW_H.dense); the freeze nudges by whole rows. */
const DENSE_ROW_H = 30;

/**
 * The live request log with its header: count, the since scope chip and the "N new" pill.
 * Stable under live traffic (plan 3.1 #5, 3.8): while held (pointer on the list, focus in the
 * subject) the rows under the pointer don't move. RequestLog already keeps the viewport anchored
 * once scrolled; at the very top new rows would still push everything down, so holding nudges the
 * scroller 1px off the top, which hands the job to that anchoring. Arrivals collect behind the
 * "N new" pill; releasing the hold at the top resumes the live tail.
 */
function RequestsList() {
  const rows = logRows.value;
  const total = tracesState.value.length;
  const filtered = logQuery.value.trim() !== "" || !!route.value.since;
  const held = liveHold.value;
  const r = route.value;
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Newest row the reader has seen; rows above it are "new". null = live tail, nothing pending. */
  const seen = useSignal<string | null>(null);
  const frozeAtTop = useRef(false);

  const scroller = () => wrapRef.current?.querySelector<HTMLElement>(".rlog-scroll") ?? null;
  const fresh = seen.value
    ? Math.max(
        0,
        rows.findIndex((t) => t.id === seen.value),
      )
    : 0;

  /**
   * Nudge the scroller 1px off the top so RequestLog's scroll anchoring keeps the rows still. A list
   * shorter than its viewport can't scroll at all: pad it while held so it can.
   */
  const freeze = (el: HTMLElement) => {
    if (el.scrollHeight <= el.clientHeight + 1) el.style.paddingBottom = `${el.clientHeight}px`;
    el.scrollTop = 1;
    frozeAtTop.current = el.scrollTop > 0;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the hold flipping only
  useLayoutEffect(() => {
    const el = scroller();
    const rowsNow = logRows.peek();
    if (held) {
      if (!seen.peek()) seen.value = rowsNow[0]?.id ?? null;
      if (el && el.scrollTop === 0) freeze(el);
      return;
    }
    // Released: if the reader is still where the freeze left them, rejoin the live tail.
    const at = seen.peek() ? rowsNow.findIndex((t) => t.id === seen.peek()) : 0;
    if (el && frozeAtTop.current && el.scrollTop <= Math.max(0, at) * DENSE_ROW_H + 1) {
      el.scrollTop = 0;
      seen.value = null;
    } else if (at <= 0) seen.value = null;
    if (el) el.style.paddingBottom = "";
    frozeAtTop.current = false;
  }, [held]);

  // A new query starts the list from the top (RequestLog scrolls there): nothing is pending.
  const q = logQuery.value;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `q` is the trigger
  useEffect(() => {
    seen.value = liveHold.peek() ? (logRows.peek()[0]?.id ?? null) : null;
  }, [q]);

  const showNew = () => {
    const el = scroller();
    if (el) el.scrollTop = 0;
    seen.value = rows[0]?.id ?? null;
    // Still held: stay frozen at the new top.
    if (liveHold.peek() && el) freeze(el);
    else seen.value = null;
  };

  // Scrolling back to the top by hand also catches up.
  const onScroll = (e: Event) => {
    const el = e.target as HTMLElement;
    if (!el.classList?.contains("rlog-scroll") || el.scrollTop > 0 || liveHold.peek()) return;
    seen.value = null;
  };

  const sinceCount = r.since ? countSince(tracesState.value, r.since) : 0;

  return (
    <div class="rv-list" ref={wrapRef} onScrollCapture={onScroll}>
      <header class="list-head">
        <h2 class="list-title">
          Requests{" "}
          {total > 0 && (
            <span class="count" title={filtered ? `${rows.length} of ${total} match the filter` : undefined}>
              {filtered ? `${rows.length}/${total}` : total}
            </span>
          )}
        </h2>
        {fresh > 0 && (
          <button
            type="button"
            class="new-pill"
            onClick={showNew}
            title="New requests arrived while you were reading; the list held still"
          >
            {fresh} new ↑
          </button>
        )}
        {r.since && (
          <span
            class="scope-chip"
            title={`Scoped to edit e${r.since} and later: ${sinceCount} retained request${sinceCount === 1 ? "" : "s"}. Esc or x clears it.`}
          >
            since e{r.since}
            <button
              type="button"
              class="scope-chip-x"
              aria-label="Clear the since scope"
              onClick={() => setSince(undefined)}
            >
              ×
            </button>
          </span>
        )}
        <span class="list-hint dim">
          <kbd>j</kbd> <kbd>k</kbd> move, <kbd>Enter</kbd> open
        </span>
      </header>
      <RequestLog variant="dense" label="Requests" />
    </div>
  );
}

function countSince(list: readonly TraceSummary[], since: string): number {
  const e = Number(since);
  if (!Number.isFinite(e)) return 0;
  let n = 0;
  for (const t of list) if ((t.facts?.epoch ?? -1) >= e) n++;
  return n;
}

/* ================================================================ request subject */

function RequestSubject({ r }: { r: Route }) {
  const rows = logRows.value;
  const id = selectedTraceId.value;
  const i = id ? rows.findIndex((t) => t.id === id) : -1;
  const newer = i > 0 ? rows[i - 1] : undefined;
  const older = i >= 0 ? rows[i + 1] : undefined;
  const isTrace = r.view === "trace";

  return (
    <div class="subject">
      <div class="subject-bar">
        <span class="subject-kind">{r.view === "compare" ? "Compare" : isTrace ? "Request" : "New request"}</span>
        {isTrace && (
          <span class="subject-nav">
            <button
              type="button"
              class="sbtn"
              disabled={!newer}
              onClick={() => newer && void loadTrace(newer.id, "user")}
              title="Newer request in the list"
              aria-label="Newer request"
            >
              ‹
            </button>
            <button
              type="button"
              class="sbtn"
              disabled={!older}
              onClick={() => older && void loadTrace(older.id, "user")}
              title="Older request in the list"
              aria-label="Older request"
            >
              ›
            </button>
          </span>
        )}
        <button
          type="button"
          class="source-close subject-close"
          onClick={closeSubject}
          aria-label="Close"
          title="Close (the list takes the full width)"
        >
          ×
        </button>
      </div>
      {builderOpen.value && <BuilderDrawer />}
      {r.view === "trace" && <TraceSubject traceId={r.traceId} />}
      {r.view === "compare" && <ComparePending a={r.a} b={r.b} />}
    </div>
  );
}

function TraceSubject({ traceId }: { traceId: string }) {
  const t = selectedTrace.value;
  if (t?.id !== traceId) {
    return (
      <div class="subject-loading">
        <Skeleton lines={6} />
      </div>
    );
  }
  return (
    <>
      <TraceHeader />
      <JourneyPane />
      <Inspector />
      <Details />
    </>
  );
}

/** Compare (#/cmp/a..b) until WP8's CompareView lands: both requests, one click each. */
function ComparePending({ a, b }: { a: string; b: string }) {
  const list = tracesState.value;
  const row = (label: string, id: string) => {
    const t = list.find((x) => x.id === id);
    return (
      <li class="cmp-row">
        <span class="cmp-label mono">{label}</span>
        {t ? (
          <button type="button" class="link-btn mono" onClick={() => void loadTrace(id, "user")}>
            {t.method} {t.url} · {fmtMs(t.duration)}
          </button>
        ) : (
          <span class="dim">not retained any more</span>
        )}
      </li>
    );
  };
  return (
    <div class="subject-body">
      <p class="subject-lead">Side-by-side compare isn't built yet. Open either request:</p>
      <ul class="cmp-list">
        {row("A", a)}
        {row("B", b)}
      </ul>
    </div>
  );
}

/** Request builder drawer, with the route picker the old sidebar used to provide. */
function BuilderDrawer() {
  const routes = routesState.value?.routes ?? [];
  const key = selectedRouteKey.value ?? "";
  const groups = useComputed(() => {
    const m = new Map<string, NonNullable<typeof routesState.value>["routes"]>();
    for (const r of routesState.value?.routes ?? []) {
      const g = r.path.split("/").filter(Boolean)[0] ?? "root";
      const list = m.get(g) ?? [];
      list.push(r);
      m.set(g, list);
    }
    return [...m.entries()].sort(([x], [y]) => x.localeCompare(y));
  }).value;

  return (
    <section class="builder-drawer" aria-label="Request builder">
      <header class="builder-drawer-head">
        <label class="builder-drawer-title" for="builder-route">
          New request
        </label>
        <select
          id="builder-route"
          class="builder-route-pick mono"
          value={key}
          onChange={(e) => {
            const [id, method] = (e.target as HTMLSelectElement).value.split("::");
            const found = routes.find((r) => r.id === id);
            if (found && method) selectRoute(found, method);
          }}
        >
          <option value="" disabled>
            {routes.length ? "Pick a route…" : "No routes found"}
          </option>
          {groups.map(([g, items]) => (
            <optgroup key={g} label={`/${g}`}>
              {items.flatMap((r) =>
                r.methods.map((m) => (
                  <option key={`${r.id}::${m.method}`} value={`${r.id}::${m.method}`}>
                    {m.method} {r.path}
                    {m.schemas.length > 0 ? "  (schema)" : ""}
                  </option>
                )),
              )}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          class="source-close"
          onClick={closeBuilder}
          aria-label="Close request builder"
          title="Close (the builder keeps your edits)"
        >
          ×
        </button>
      </header>
      <RequestBuilder />
    </section>
  );
}

/* ================================================================ changes */

/**
 * Changes (#/changes[/e<id>]) until WP9b's timeline: the dev-rebuild epochs seen in the retained
 * requests, newest first, with their traffic. Each row opens that epoch's newest request.
 */
function ChangesList({ r }: { r: Extract<Route, { view: "changes" }> }) {
  const epochs = useComputed(() => {
    const m = new Map<number, { n: number; first: number; last: number; newest: TraceSummary; routes: Set<string> }>();
    for (const t of tracesState.value) {
      const e = t.facts?.epoch;
      if (e === undefined || t.kind === "asset") continue;
      const cur = m.get(e);
      if (!cur) m.set(e, { n: 1, first: t.startedAt, last: t.startedAt, newest: t, routes: new Set([routeKeyOf(t)]) });
      else {
        cur.n++;
        cur.first = Math.min(cur.first, t.startedAt);
        if (t.startedAt > cur.last) {
          cur.last = t.startedAt;
          cur.newest = t;
        }
        cur.routes.add(routeKeyOf(t));
      }
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }).value;
  const listRef = useRef<HTMLOListElement>(null);

  // #/changes/e<id>: bring that epoch into view.
  useEffect(() => {
    if (!r.epoch) return;
    listRef.current?.querySelector(`[data-epoch="${CSS.escape(r.epoch)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [r.epoch]);

  return (
    <section class="changes-view" aria-labelledby="changes-title">
      <header class="list-head">
        <h2 id="changes-title" class="list-title">
          Changes {epochs.length > 0 && <span class="count">{epochs.length}</span>}
        </h2>
        <span class="list-hint dim">Each dev rebuild (an edit) starts a new epoch.</span>
      </header>
      {epochs.length === 0 ? (
        <p class="muted">No requests yet. Edit a file and send a request: each rebuild shows up here.</p>
      ) : (
        <ol class="changes-list" ref={listRef}>
          {epochs.map(([e, info]) => {
            const on = r.epoch === String(e);
            return (
              <li key={e} data-epoch={String(e)} class={`changes-row ${on ? "changes-row-on" : ""}`}>
                <button
                  type="button"
                  class="changes-open"
                  onClick={() => void loadTrace(info.newest.id, "user")}
                  title="Open this epoch's newest request"
                >
                  <span class="mono changes-epoch">e{e}</span>
                  <span class="mono dim">
                    {new Date(info.first).toLocaleTimeString()} – {new Date(info.last).toLocaleTimeString()}
                  </span>
                  <span>
                    {info.n} request{info.n === 1 ? "" : "s"} · {info.routes.size} route
                    {info.routes.size === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
