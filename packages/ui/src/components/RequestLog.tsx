import { useComputed, useSignalEffect } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FindingSeverity, FindingSummary, TraceSummary } from "../api/types";
import { pinnedIds } from "../state/compare";
import { ruleLabel } from "../state/framework";
import { QUERY_KEYS, type SuggestResult, applySuggestion, findingQuery, suggest } from "../state/querySuggest";
import {
  hasTextTerms,
  logBatchSize,
  logCursor,
  logQuery,
  logRows,
  moveCursor,
  queryErrors,
  routeLatency,
  searchError,
  searchState,
  splitUrl,
} from "../state/requestLog";
import {
  type Percentiles,
  approx,
  fmtMs,
  ioCount,
  isHandledError,
  routeKeyOf,
  statusClass,
  worseSeverity,
} from "../state/stats";
import {
  followLive,
  frameworkCopy,
  loadStatus,
  loadTrace,
  mainView,
  routesState,
  selectedTraceId,
  tracesState,
} from "../state/store";
import { Skeleton } from "./Skeleton";

/*
 * The dense request log (plan feature 7). One component, two layouts:
 *  - "dense": the Requests view, one 30px line per request with every column;
 *  - "compact": the sidebar Traffic tab, two lines per request.
 * Rows are windowed (only the visible slice plus some overscan is in the DOM), so every retained
 * trace is reachable by scrolling, with no paging.
 */

export type LogVariant = "dense" | "compact";

const ROW_H: Record<LogVariant, number> = { dense: 30, compact: 50 };
const OVERSCAN = 8;

/* ================================================================ query bar */

export function QueryBar({ id, variant }: { id: string; variant: LogVariant }) {
  const q = logQuery.value;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [caret, setCaret] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `${id}-suggest`;

  // Known route templates (traffic first, then discovered routes) for route: completion.
  const routes = useComputed(() => {
    const out: string[] = [];
    for (const t of tracesState.value) if (t.kind !== "asset") out.push(t.route ?? t.path);
    for (const r of routesState.value?.routes ?? []) out.push(r.nextRoute);
    return out;
  }).value;

  const fw = frameworkCopy.value;
  const res: SuggestResult = useMemo(() => suggest(q, caret, routes, fw), [q, caret, routes, fw]);
  const showList = open && res.items.length > 0;
  const activeIdx = showList ? Math.min(active, res.items.length - 1) : -1;

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? q.length);

  const accept = (i: number) => {
    const s = res.items[i];
    if (!s) return;
    const next = applySuggestion(q, caret, res, s);
    logQuery.value = next.value;
    setCaret(next.caret);
    setActive(-1);
    // Keep completing: a key suggestion leads straight into its values.
    setOpen(res.isKey);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (showList && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = res.items.length;
      setActive((cur) => (e.key === "ArrowDown" ? (cur + 1) % n : (cur <= 0 ? n : cur) - 1));
      return;
    }
    if (showList && activeIdx >= 0 && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      accept(activeIdx);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (showList) setOpen(false);
      else if (q) logQuery.value = "";
      else inputRef.current?.blur();
      return;
    }
    if (e.key === "Enter") {
      // Done typing: hand the keyboard to the log (j/k, Enter) starting at the first match.
      e.preventDefault();
      setOpen(false);
      inputRef.current?.blur();
      if (!logCursor.value) moveCursor(1);
    }
  };

  const errors = queryErrors.value;
  const searching = hasTextTerms.value && searchState.value === "searching";
  const searchFailed = hasTextTerms.value && searchState.value === "error";

  return (
    <div class={`qbar qbar-${variant}`}>
      <search class="search qbar-search">
        <label class="sr-only" for={id}>
          Filter requests (query: status:, dur:, route:, method:, has:, kind:, cold:, or quoted text)
        </label>
        <span class="qbar-slash mono" aria-hidden="true" title="Press / to focus">
          /
        </span>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeIdx >= 0 ? `${listId}-${activeIdx}` : undefined}
          aria-describedby={`${id}-help`}
          placeholder={
            variant === "dense" ? 'status:5xx dur:>200 route:/api/* has:n+1 "timeout"' : "status:5xx has:n+1 …"
          }
          value={q}
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => {
            const el = e.target as HTMLInputElement;
            logQuery.value = el.value;
            logCursor.value = null;
            setCaret(el.selectionStart ?? el.value.length);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => {
            syncCaret();
            setOpen(true);
          }}
          onClick={syncCaret}
          onKeyUp={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") syncCaret();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        {q && (
          <button
            type="button"
            class="search-clear"
            onClick={() => {
              logQuery.value = "";
              inputRef.current?.focus();
            }}
            aria-label="Clear query"
          >
            ×
          </button>
        )}
        {showList && (
          // ARIA 1.2 combobox: focus stays in the input, options are reached via aria-activedescendant,
          // so neither the listbox nor its options take focus (and <select> can't do this).
          // biome-ignore lint/a11y/useSemanticElements: combobox popup, see above
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: combobox popup, see above
          // biome-ignore lint/a11y/useFocusableInteractive: combobox popup, see above
          <ul id={listId} class="qbar-list" role="listbox" aria-label="Suggestions">
            {res.items.map((s, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: combobox option, see above
              <li
                key={s.label}
                // biome-ignore lint/a11y/useSemanticElements: combobox option, see above
                id={`${listId}-${i}`}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: combobox option, see above
                role="option"
                aria-selected={i === activeIdx}
                class={`qbar-opt ${i === activeIdx ? "qbar-opt-active" : ""}`}
                // mousedown, not click: it fires before the input's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(i);
                }}
              >
                <span class="mono">{s.label}</span>
                {s.hint && <span class="qbar-hint dim">{s.hint}</span>}
              </li>
            ))}
          </ul>
        )}
      </search>
      <output id={`${id}-help`} class="qbar-status" aria-live="polite">
        {errors.length > 0 && <span class="qbar-err">{errors.join(" · ")}</span>}
        {searching && <span class="dim">Searching logs and bodies…</span>}
        {searchFailed && (
          <span class="qbar-err" title={searchError.value ?? undefined}>
            Server search failed: matching url, route and error only.
          </span>
        )}
        {variant === "dense" && errors.length === 0 && !q && (
          <span class="dim qbar-keys">
            {QUERY_KEYS.map((k) => (
              <button
                key={k.key}
                type="button"
                class="qbar-key mono"
                title={k.hint}
                onClick={() => {
                  logQuery.value = q ? `${q} ${k.example}` : k.example;
                  inputRef.current?.focus();
                }}
              >
                {k.example}
              </button>
            ))}
          </span>
        )}
      </output>
    </div>
  );
}

/* ============================================================ windowed log */

/** Visible slice of a fixed-height list inside its own scroll container. */
function useWindow(ref: { current: HTMLElement | null }, count: number, rowH: number, enabled: boolean) {
  const [view, setView] = useState({ top: 0, height: 600 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `enabled` re-attaches once the scroller mounts
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      setView((v) =>
        v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight },
      );
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, enabled]);
  const start = Math.max(0, Math.floor(view.top / rowH) - OVERSCAN);
  const end = Math.min(count, Math.ceil((view.top + view.height) / rowH) + OVERSCAN);
  return { start, end };
}

export function RequestLog({ variant, label }: { variant: LogVariant; label: string }) {
  const rows = logRows.value;
  const total = tracesState.value.length;
  const selected = selectedTraceId.value;
  const cursor = logCursor.value;
  const latency = routeLatency.value;
  const batchSize = logBatchSize.value;
  const pinned = pinnedIds.value;
  const rowH = ROW_H[variant];
  const scrollRef = useRef<HTMLDivElement>(null);
  const { start, end } = useWindow(scrollRef, rows.length, rowH, rows.length > 0);
  // Roving tabindex: exactly one rendered row is in the Tab order: the cursor, else the open trace,
  // else the first rendered row. Only ids inside the window count, or a cursor scrolled out of view
  // (or evicted) would leave every rendered row at tabIndex -1.
  const windowRows = rows.slice(start, end);
  const inWindow = (id: string | null) => !!id && windowRows.some((t) => t.id === id);
  const tabId = inWindow(cursor) ? cursor : inWindow(selected) ? selected : windowRows[0]?.id;

  // Keep the j/k cursor in view, and move focus onto it unless the user is typing somewhere.
  useSignalEffect(() => {
    const id = logCursor.value;
    const el = scrollRef.current;
    if (!id || !el) return;
    const i = logRows.peek().findIndex((t) => t.id === id);
    if (i < 0) return;
    const top = i * rowH;
    const header = variant === "dense" ? rowH : 0;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight - header) el.scrollTop = top + rowH - el.clientHeight + header;
    // After the scroll has re-rendered the window, so the row exists.
    setTimeout(() => {
      // A later j/k already moved on: focusing this row would pull the cursor back (onFocus).
      if (logCursor.peek() !== id) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
      // Only the log that has focus, or none at all, takes it (two logs can be on screen; with
      // nothing focused, the Requests view's log wins over the sidebar's).
      if (active && active !== document.body && !el.contains(active)) return;
      if (!el.contains(active) && variant === "compact" && mainView.peek() === "requests") return;
      el.querySelector<HTMLElement>(`[data-trace-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    }, 40);
  });

  // The open request's row in view: a deep link (#/r/<id>), Back/Forward or a click elsewhere
  // (Overview, a finding) can select a request far down the list. Once per selection, and only
  // once its row exists: a deep link lands before the list loads, and the scroller itself only
  // mounts with the first rows, so this runs after the commit (a signal effect would fire before
  // the scroller exists and never retry). Follow keeps to the live tail itself, so it is left alone.
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!selected || revealed.current === selected || !el || followLive.peek()) return;
    const i = rows.findIndex((t) => t.id === selected);
    if (i < 0) return;
    revealed.current = selected;
    const top = i * rowH;
    const header = variant === "dense" ? rowH : 0;
    if (top < el.scrollTop || top + rowH > el.scrollTop + el.clientHeight - header)
      el.scrollTop = Math.max(0, top - (el.clientHeight - header) / 2);
  }, [selected, rows, rowH, variant]);

  // Scroll anchoring. New traces are prepended and rows are absolutely positioned, so the browser's
  // own anchoring can't help: without this every arrival slides the rows a scrolled-down reader is on.
  // Keep the row that was at the top of the viewport there. At scrollTop 0 the live tail flows in.
  const prevRows = useRef(rows);
  useLayoutEffect(() => {
    const before = prevRows.current;
    prevRows.current = rows;
    const el = scrollRef.current;
    if (!el || before === rows || el.scrollTop <= 0) return;
    const was = Math.floor(el.scrollTop / rowH);
    const id = before[was]?.id;
    if (!id) return;
    const now = rows.findIndex((t) => t.id === id);
    if (now >= 0 && now !== was) el.scrollTop += (now - was) * rowH;
  }, [rows, rowH]);

  // A query change starts the list from the top again (not the mount: a remounted list may just
  // have scrolled to the open request).
  const q = logQuery.value;
  const lastQ = useRef(q);
  useEffect(() => {
    if (lastQ.current === q) return;
    lastQ.current = q;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [q]);

  if (total === 0) {
    return (
      <div class={`rlog rlog-${variant}`}>
        {loadStatus.value === "loading" ? (
          <div class="skeleton-wrap">
            <Skeleton lines={5} />
          </div>
        ) : (
          <div class="muted rlog-empty">No requests yet. Send one to light up the journey.</div>
        )}
      </div>
    );
  }

  return (
    <div class={`rlog rlog-${variant}`}>
      {rows.length === 0 ? (
        <div class="muted rlog-empty">
          {hasTextTerms.value && searchState.value === "searching" ? (
            "Searching logs and bodies…"
          ) : (
            <>
              No requests match <code>{q}</code>.{" "}
              <button type="button" class="link-btn" onClick={() => (logQuery.value = "")}>
                Clear the query
              </button>
            </>
          )}
        </div>
      ) : (
        <div class="rlog-scroll" ref={scrollRef}>
          {variant === "dense" && <DenseHeader />}
          <ul
            class="rlog-list trace-list"
            aria-label={`${label}: ${rows.length} of ${total} requests. j and k move, Enter opens.`}
            style={{ height: `${rows.length * rowH}px` }}
          >
            {windowRows.map((t, k) => (
              <LogRow
                key={t.id}
                t={t}
                index={start + k}
                setSize={rows.length}
                top={(start + k) * rowH}
                variant={variant}
                selected={selected === t.id}
                cursor={cursor === t.id}
                tabbable={tabId === t.id}
                lat={t.done ? latency(t) : undefined}
                runs={batchSize.get(t.id)}
                pinned={pinned.has(t.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DenseHeader() {
  return (
    <div class="rlog-head" aria-hidden="true">
      <span>time</span>
      <span>method</span>
      <span>path</span>
      <span class="num">status</span>
      <span title="Bar scaled to 2x the route's warm p95; the tick marks the p95">duration</span>
      <span class="num" title="Time to first byte">
        ttfb
      </span>
      <span class="num" title="Response size">
        KB
      </span>
      <span class="num" title="db + cache + fetch calls">
        io
      </span>
      <span class="rlog-findcol" title="Findings: the dot is the worst severity, the number how many" />
    </div>
  );
}

function hhmmss(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function kb(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  const k = bytes / 1024;
  return k < 10 ? k.toFixed(1) : String(Math.round(k));
}

/** The worst finding (first one at the worst severity) drives the badge and its prefilled query. */
function worstFinding(fs: readonly FindingSummary[] | undefined): { sev?: FindingSeverity; f?: FindingSummary } {
  let sev: FindingSeverity | undefined;
  let f: FindingSummary | undefined;
  for (const x of fs ?? []) {
    const next = worseSeverity(sev, x.severity);
    if (!f || next !== sev) {
      f = x;
      sev = next;
    }
  }
  return { sev, f };
}

function LogRow({
  t,
  index,
  setSize,
  top,
  variant,
  selected,
  cursor,
  tabbable,
  lat,
  runs,
  pinned,
}: {
  t: TraceSummary;
  index: number;
  setSize: number;
  top: number;
  variant: LogVariant;
  selected: boolean;
  cursor: boolean;
  tabbable: boolean;
  lat: Percentiles | undefined;
  /** Runs folded into this row (a Replay xN batch), when 2+. */
  runs?: number;
  pinned?: boolean;
}) {
  const f = t.facts;
  const io = ioCount(t);
  const { sev, f: worst } = worstFinding(t.findings);
  const nFindings = t.findings?.length ?? 0;
  const status = t.status ?? (t.done ? "—" : "…");
  const dur = t.duration;
  const url = splitUrl(t.path, t.url);
  const ariaLabel = [
    t.method,
    `${url.path}${url.query}`,
    t.status !== undefined ? `status ${t.status}` : t.done ? "no status" : "in flight",
    dur !== undefined ? `${Math.round(dur)} milliseconds` : undefined,
    isHandledError(t) ? "handled error" : undefined,
    f?.cold ? "cold" : undefined,
    t.pathTrace && !t.pathTrace.supersededBy ? "path trace" : undefined,
    runs ? `replay batch of ${runs} runs` : undefined,
    pinned ? "pinned" : undefined,
    nFindings ? `${nFindings} finding${nFindings === 1 ? "" : "s"}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  const cold = f?.cold ? (
    <span
      class="cold-badge"
      title={
        frameworkCopy.value.isNext && f.compileMs > 0
          ? `Cold: ${Math.round(f.compileMs)}ms compiling`
          : frameworkCopy.value.coldPlain
      }
    >
      cold
    </span>
  ) : null;
  const handled = isHandledError(t) ? (
    <span class="handled-badge" title={`Handled error (the response still went out): ${t.error}`}>
      err
    </span>
  ) : null;

  const batch = runs ? (
    <span class="batch-badge" title={`Replay batch: ${runs} runs folded into this row (the newest, or the one open)`}>
      x{runs}
    </span>
  ) : null;
  const pin = pinned ? (
    <span class="pin-badge" title="Pinned: kept past rotation">
      pin
    </span>
  ) : null;
  // A request-path replay (Trace path): its path opens in Path mode. A discarded attempt is not marked.
  const pathMark =
    t.pathTrace && !t.pathTrace.supersededBy ? (
      <span
        class="path-mark"
        title={`Path trace (${t.pathTrace.failed ? `capture failed: ${t.pathTrace.failed}` : t.pathTrace.quality}): a replay of ${t.pathTrace.replayOf}; opens in the Path view`}
      >
        path
      </span>
    ) : null;
  const flags = cold || handled || batch || pin || pathMark;

  return (
    <li
      class={`rlog-row ${selected ? "rlog-selected" : ""} ${cursor ? "rlog-cursor" : ""}`}
      style={{ transform: `translateY(${top}px)` }}
      aria-setsize={setSize}
      aria-posinset={index + 1}
    >
      <button
        type="button"
        class={`trace-row rlog-open ${selected ? "selected" : ""}`}
        data-trace-id={t.id}
        tabIndex={tabbable ? 0 : -1}
        onFocus={() => {
          if (logCursor.peek() !== t.id) logCursor.value = t.id;
        }}
        aria-pressed={selected}
        aria-label={ariaLabel}
        title={t.error ? `Error: ${t.error}` : `${t.method} ${t.url}`}
        onClick={() => {
          logCursor.value = t.id;
          void loadTrace(t.id, "user");
        }}
      >
        {variant === "dense" ? (
          <>
            <span class="rlog-time mono dim">{hhmmss(t.startedAt)}</span>
            <span class={`method-tag m-${t.method}`}>{t.method}</span>
            {/* Path, its query (dim) and the flags share one cell: the flags never overlap the
                path, they take their width from it and the path ellipsizes (plan 3.2). */}
            <span class="rlog-pathcell">
              <span class="trace-path mono">
                {url.path}
                {url.query && <span class="rlog-qs">{url.query}</span>}
              </span>
              {flags && (
                <span class="rlog-flags">
                  {pathMark}
                  {batch}
                  {pin}
                  {cold}
                  {handled}
                </span>
              )}
            </span>
            <span class={`status-code ${statusClass(t)} num`}>{status}</span>
            <DurBar dur={dur} lat={lat} />
            <span class="num mono dim">{f?.ttfb !== undefined ? fmtMs(f.ttfb) : "—"}</span>
            <span class="num mono dim">{kb(f?.resBytes)}</span>
            <span class={`num mono ${io ? "" : "dim"}`}>{io ?? "—"}</span>
            {/* The findings chip sits over this column (it is a sibling button, see .rlog-find). */}
            <span class="rlog-findcol" aria-hidden="true" />
          </>
        ) : (
          <>
            <span class="rlog-line">
              <span class={`status-code ${statusClass(t)}`}>{status}</span>
              <span class={`method-tag m-${t.method}`}>{t.method}</span>
              <span class="trace-path mono">{t.path}</span>
              <span class="trace-dur dim mono">{dur !== undefined ? fmtMs(dur) : ""}</span>
            </span>
            <span class="rlog-line rlog-line-2">
              <DurBar dur={dur} lat={lat} bare />
              {io !== undefined && io > 0 && (
                <span class="trace-io mono dim" title="db + cache + fetch calls">
                  {io} io
                </span>
              )}
              {pathMark}
              {batch}
              {pin}
              {cold}
              {handled}
              <span class="rlog-time mono dim">{hhmmss(t.startedAt)}</span>
            </span>
          </>
        )}
      </button>
      {sev && worst ? (
        <button
          type="button"
          class={`sev-badge sev-${sev} rlog-find`}
          tabIndex={-1}
          title={`${nFindings} finding${nFindings === 1 ? "" : "s"}; worst: ${ruleLabel(worst.rule, frameworkCopy.value)}: ${worst.title}. Click to list every request with it on this route.`}
          aria-label={`Filter requests with ${ruleLabel(worst.rule, frameworkCopy.value)} on ${routeKeyOf(t)}`}
          onClick={() => (logQuery.value = findingQuery(worst.rule, [routeKeyOf(t)]))}
        >
          <span class="sev-dot" aria-hidden="true" />
          {nFindings}
        </button>
      ) : (
        <span class="rlog-find rlog-find-none" aria-hidden="true" />
      )}
    </li>
  );
}

/**
 * Duration bar scaled to 2x the route's warm p95 (tick at the p95). Over the p95 it turns amber, past
 * 2x red. With no baseline (fewer than 2 warm samples) it is a neutral log-scaled bar.
 */
function DurBar({ dur, lat, bare = false }: { dur: number | undefined; lat: Percentiles | undefined; bare?: boolean }) {
  if (dur === undefined) return <span class="dur-cell" />;
  const p95 = lat && lat.n >= 2 ? lat.p95 : undefined;
  let width: number;
  let tone: string;
  let title: string;
  if (p95 !== undefined && p95 > 0) {
    width = Math.min(1, dur / (2 * p95));
    tone = dur <= p95 ? "ok" : dur <= 2 * p95 ? "warn" : "err";
    title = `${fmtMs(dur)} · route warm p95 ${approx(lat?.n ?? 0)}${fmtMs(p95)} (n=${lat?.n ?? 0})`;
  } else {
    width = Math.min(1, Math.log10(1 + dur) / Math.log10(1 + 5000));
    tone = "none";
    title = `${fmtMs(dur)} · no warm baseline for this route yet`;
  }
  return (
    <span class={`dur-cell ${bare ? "dur-cell-bare" : ""}`} title={title}>
      <span class="dur-track">
        <span class={`dur-fill dur-${tone}`} style={{ width: `${(width * 100).toFixed(1)}%` }} />
        {p95 !== undefined && <span class="dur-tick" />}
      </span>
      {!bare && <span class="dur-ms mono">{fmtMs(dur)}</span>}
    </span>
  );
}
