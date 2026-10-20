import { useComputed, useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { builderDims } from "../state/builder";
import { initCompare } from "../state/compare";
import { sinceNumber, tracesSince } from "../state/epochs";
import { isMobile, neighbourId } from "../state/mobile";
import { logMatchCount, logQuery, logRows } from "../state/requestLog";
import { pickerGroups } from "../state/routePick";
import { type Route, route } from "../state/router";
import {
  builderOpen,
  closeBuilder,
  closeSubject,
  frameworkCopy,
  liveHold,
  loadTrace,
  routesState,
  selectRoute,
  selectedRouteKey,
  selectedTrace,
  selectedTraceId,
  tracesState,
} from "../state/store";
import { subjectChrome } from "../state/subjectChrome";
import { ChangesView } from "./ChangesView";
import { CompareButton, CompareView, PickBanner, PinToggle } from "./CompareView";
import { Details } from "./Details";
import { Inspector } from "./Inspector";
import { JourneyPane } from "./JourneyPane";
import { useSwipe } from "./Mobile";
import { Overview, RouteSubject, overviewHeld } from "./Overview";
import { QueriesView } from "./QueriesView";
import { RequestBuilder } from "./RequestBuilder";
import { RequestLog } from "./RequestLog";
import { SinceChip } from "./SinceChip";
import { Skeleton } from "./Skeleton";
import { Split } from "./Split";
import { TraceHeader } from "./TraceHeader";

/*
 * The main area: every view is the same list | subject split (plan 3.8), driven by the route.
 *   Overview   overview          | route subject (#/route/<key>)
 *   Requests   live request log  | the open request (#/r/<id>), the builder drawer, compare
 *   Queries    query shapes      | the open shape (#/q/<fingerprint>); QueriesView owns its Split
 *   Changes    the edits timeline and each edit's verdicts (full width; ChangesView)
 * A pane with nothing to show is not drawn: no subject means the list takes the full width.
 * Each view's Split is keyed by its id, so a view switch remounts it: the width is read per view and
 * the unmount releases the live hold (a pointer left on the old list must not pause Follow).
 */

export function MainPane() {
  // Compare (WP8): its fetch, the open request's baselines, pins and the c / c c / d / p keys.
  useEffect(() => initCompare(), []);
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
          <Split key="changes" id="changes" list={<ChangesView r={r} />} listLabel="Changes" listClass="split-scroll" />
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
  const matched = logMatchCount.value;
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

  const sinceNum = sinceNumber(r.since);
  const sinceCount = sinceNum !== undefined ? tracesSince(tracesState.value, sinceNum).length : 0;

  return (
    <div class="rv-list" ref={wrapRef} onScrollCapture={onScroll}>
      <header class="list-head">
        <h2 class="list-title">
          Requests{" "}
          {total > 0 && (
            // Requests, not rows: a Replay xN batch is one row but N requests (same unit as the since chip).
            <span
              class="count"
              title={[
                filtered ? `${matched} of ${total} requests match the filter or scope` : `${total} retained requests`,
                rows.length !== matched ? `${rows.length} rows (replay batches folded)` : "",
              ]
                .filter(Boolean)
                .join("; ")}
            >
              {filtered ? `${matched}/${total}` : total}
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
        <SinceChip
          title={`Requests built by edit e${r.since} and later: ${sinceCount} retained request${sinceCount === 1 ? "" : "s"}.`}
        />
        <span class="list-hint dim">
          <kbd>j</kbd> <kbd>k</kbd> move, <kbd>Enter</kbd> open
        </span>
      </header>
      <RequestLog variant="dense" label="Requests" />
    </div>
  );
}

/* ================================================================ request subject */

function RequestSubject({ r }: { r: Route }) {
  const rows = logRows.value;
  const id = selectedTraceId.value;
  const i = id ? rows.findIndex((t) => t.id === id) : -1;
  const newer = i > 0 ? rows[i - 1] : undefined;
  const older = i >= 0 ? rows[i + 1] : undefined;
  const isTrace = r.view === "trace";
  // Phones (plan 3.6): a horizontal flick on the open request moves to the newer / older one.
  const swipe = useSwipe((dir) => {
    const next = neighbourId(logRows.peek(), selectedTraceId.peek(), dir);
    if (next && route.peek().view === "trace") void loadTrace(next, "user");
  });

  // One "New request" label and one close, kept in view (subjectChrome): over a request the sticky
  // bar's close closes the builder; the builder alone pins its own head.
  const chrome = subjectChrome(r.view, builderOpen.value);

  return (
    <div class="subject" {...(isTrace && isMobile.value ? swipe : {})}>
      {chrome.bar && (
        <SubjectBar r={r} kind={chrome.kind} close={chrome.barClose} newer={newer?.id} older={older?.id} />
      )}
      {builderOpen.value && <BuilderDrawer close={chrome.drawerClose} pinned={chrome.drawerHeadPinned} />}
      {r.view === "trace" && <PickBanner />}
      {r.view === "trace" && <TraceSubject traceId={r.traceId} />}
      {r.view === "compare" && <CompareView a={r.a} b={r.b} />}
    </div>
  );
}

function SubjectBar({
  r,
  kind,
  close,
  newer,
  older,
}: { r: Route; kind: string; close: "subject" | "builder" | null; newer?: string; older?: string }) {
  const isTrace = r.view === "trace";
  return (
    <div class="subject-bar">
      <span class="subject-kind">{kind}</span>
      {isTrace && (
        <span class="subject-nav">
          <button
            type="button"
            class="sbtn"
            disabled={!newer}
            onClick={() => newer && void loadTrace(newer, "user")}
            title="Newer request in the list"
            aria-label="Newer request"
          >
            ‹
          </button>
          <button
            type="button"
            class="sbtn"
            disabled={!older}
            onClick={() => older && void loadTrace(older, "user")}
            title="Older request in the list"
            aria-label="Older request"
          >
            ›
          </button>
        </span>
      )}
      {isTrace && (
        <span class="subject-nav">
          <CompareButton traceId={r.traceId} />
          <PinToggle traceId={r.traceId} />
        </span>
      )}
      {close && (
        <button
          type="button"
          class="source-close subject-close"
          onClick={close === "builder" ? closeBuilder : closeSubject}
          aria-label={close === "builder" ? "Close request builder" : "Close"}
          title={close === "builder" ? "Close (the builder keeps your edits)" : "Close (the list takes the full width)"}
        >
          ×
        </button>
      )}
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

/** Request builder drawer, with the route picker the old sidebar used to provide. */
function BuilderDrawer({ close, pinned }: { close: boolean; pinned: boolean }) {
  const routes = routesState.value?.routes ?? [];
  const key = selectedRouteKey.value ?? "";
  const dims = builderDims.value;
  // Next keeps its `:param` paths; other frameworks show the template traces name. Regex routes are
  // listed last, disabled (nothing to fill); a template + method in two files names the file.
  const groups = useComputed(() => pickerGroups(routesState.value?.routes ?? [], frameworkCopy.value.isNext)).value;

  return (
    <section class={`builder-drawer${dims ? " dims-subject" : ""}`} aria-label="Request builder">
      <header class={`builder-drawer-head${pinned ? " pinned" : ""}`}>
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
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled} title={o.reason}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {close && (
          <button
            type="button"
            class="source-close"
            onClick={closeBuilder}
            aria-label="Close request builder"
            title="Close (the builder keeps your edits)"
          >
            ×
          </button>
        )}
      </header>
      {dims && (
        <p class="builder-drawer-note">
          Below, dimmed: the {route.value.view === "compare" ? "compare" : "request"} you had open, not this one. Send
          to replace it with the result.
        </p>
      )}
      <RequestBuilder />
    </section>
  );
}
