import { effect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { MainPane } from "./components/MainPane";
import { SourcePeek } from "./components/SourcePeek";
import { TopBar } from "./components/TopBar";
import { selectHop, selectedHopId } from "./state/journey";
import { type KeyScope, activeScopes, handleKeydown, register } from "./state/keymap";
import { QUERY_INPUT_MAIN, logCursor, logRows, logVisible, moveCursor, openCursor } from "./state/requestLog";
import { go, route } from "./state/router";
import { bootstrap, initRouting, loadTrace, selectedTrace, selectedTraceId, startLive, stopLive } from "./state/store";

/**
 * Keys still handled outside the keymap: Up/Down on a focused log row and Enter to open the cursor
 * row. Everything else (j/k, [ ], /, and the keys other components register) goes through
 * state/keymap first. Ignored while typing and with modifiers, so nothing shadows the browser.
 */
function onGlobalKey(e: KeyboardEvent): void {
  if (handleKeydown(e)) return;
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (!logVisible()) return;
  const onRow = !!el?.closest?.("[data-trace-id]");
  // Up/Down only on a log row: the journey canvas and other widgets own the arrows elsewhere.
  if (onRow && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    moveSelection(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" && !el?.closest?.("button, a, [role=tab], summary")) {
    if (openCursor()) e.preventDefault();
  }
}

/**
 * j/k (plan 3.9): move through the list; with a request open the subject follows (history is
 * replaced, not pushed, so Back still leaves the list in one step). Starts from the open request
 * when there is no cursor yet.
 */
function moveSelection(delta: number): void {
  const sel = selectedTraceId.peek();
  if (!logCursor.peek() && sel) logCursor.value = sel;
  moveCursor(delta);
  const r = route.peek();
  const id = logCursor.peek();
  if (r.view === "trace" && id && id !== r.traceId) void loadTrace(id, "user", { replace: true });
}

/** `[` / `]`: the newer / older request beside the open one, without focusing the list. */
function stepSubject(delta: number): void {
  const r = route.peek();
  if (r.view !== "trace") return;
  const rows = logRows.peek();
  const i = rows.findIndex((t) => t.id === r.traceId);
  const next = i >= 0 ? rows[i + delta] : undefined;
  if (!next) return;
  logCursor.value = next.id;
  void loadTrace(next.id, "user", { replace: true });
}

/**
 * The shell's half of the keymap: which scopes are active (from the route and the focused pane),
 * and the list/subject keys. "canvas" is active while focus is inside the span canvas
 * (`data-key-scope="canvas"`), so its `/` and `[ ]` win over the list's there.
 */
function initKeys(): () => void {
  const sync = () => {
    const r = route.peek();
    const next = new Set<KeyScope>();
    if (r.view === "requests" || r.view === "trace" || r.view === "compare") next.add("list");
    if (r.view === "trace" || r.view === "compare") next.add("subject");
    if (r.view === "trace") {
      next.add("trace");
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest?.('[data-key-scope="canvas"]')) next.add("canvas");
    }
    const cur = activeScopes.peek();
    if (cur.size !== next.size || [...next].some((s) => !cur.has(s))) activeScopes.value = next;
  };
  const onFocus = () => sync();
  // focusout fires before the next element has focus; read it once focus settled.
  const onBlur = () => setTimeout(sync, 0);
  document.addEventListener("focusin", onFocus);
  document.addEventListener("focusout", onBlur);
  const stopRoute = effect(() => {
    route.value;
    sync();
  });
  const offs = [
    register("global", "/", "Filter the list", () => {
      const input = document.getElementById(QUERY_INPUT_MAIN) as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }),
    register("list", "j", "Next request (the open one follows)", () => moveSelection(1), { when: logVisible }),
    register("list", "k", "Previous request (the open one follows)", () => moveSelection(-1), { when: logVisible }),
    register("subject", "[", "Newer request", () => stepSubject(-1)),
    register("subject", "]", "Older request", () => stepSubject(1)),
  ];
  return () => {
    for (const off of offs) off();
    stopRoute();
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("focusout", onBlur);
  };
}

/**
 * `#/r/<trace>/s/<span>` <-> the span selected in the canvas. The hash selects the span once its
 * trace has loaded; picking another span rewrites the hash in place (no history entry per click).
 * Lives here, not in the store, because state/journey imports the store.
 */
function initSpanRouting(): () => void {
  const toHop = effect(() => {
    const r = route.value;
    const t = selectedTrace.value;
    if (r.view !== "trace" || !r.spanId || t?.id !== r.traceId) return;
    const span = r.spanId;
    // After this batch settles: a new trace first resets the span selection (state/journey).
    queueMicrotask(() => {
      const cur = route.peek();
      if (cur.view !== "trace" || cur.spanId !== span || selectedTrace.peek()?.id !== t.id) return;
      if (selectedHopId.peek() !== span && t.spans.some((s) => s.id === span)) selectHop(span);
    });
  });

  let traceSeen: string | null = null;
  let lastHop: string | null = null;
  const toHash = effect(() => {
    const hop = selectedHopId.value;
    const tid = selectedTrace.value?.id ?? null;
    const prev = lastHop;
    lastHop = hop;
    // A trace switch resets the hop to null; that reset must not strip a deep-linked span.
    if (tid !== traceSeen) {
      traceSeen = tid;
      return;
    }
    const r = route.peek();
    if (r.view !== "trace" || r.traceId !== tid || (r.spanId ?? null) === hop) return;
    if (hop) go({ ...r, spanId: hop }, { replace: true });
    else if (prev !== null && prev === r.spanId) {
      const { spanId: _drop, ...rest } = r;
      go(rest, { replace: true });
    }
  });
  return () => {
    toHop();
    toHash();
  };
}

export function App() {
  useEffect(() => {
    const disposeRouting = initRouting();
    const disposeSpans = initSpanRouting();
    const disposeKeys = initKeys();
    void bootstrap();
    startLive();
    window.addEventListener("keydown", onGlobalKey);
    return () => {
      window.removeEventListener("keydown", onGlobalKey);
      disposeKeys();
      disposeSpans();
      disposeRouting();
      stopLive();
    };
  }, []);

  return (
    <div class="app">
      <a href="#main" class="skip-link">
        Skip to main content
      </a>
      <TopBar />
      <MainPane />
      <SourcePeek />
    </div>
  );
}
