import { batch, effect } from "@preact/signals";
import { toggleListRail } from "../components/Split";
import { highlight } from "./canvas";
import { epochList, knownEpochIds } from "./epochs";
import { clearHighlight, selectHop, selectedHopId } from "./journey";
import { type KeyScope, activeScopes, handleKeydown, modalScope, register } from "./keymap";
import { cheatsheetOpen, paletteOpen, toggleCheatsheet, togglePalette } from "./palette";
import { closeShape } from "./queries";
import { QUERY_INPUT_MAIN, logCursor, logQuery, logRows, logVisible, moveCursor, openCursor } from "./requestLog";
import { type Route, go, route, setSince } from "./router";
import {
  type MainView,
  builderOpen,
  closeBuilder,
  closeSubject,
  loadTrace,
  mainView,
  openBuilder,
  selectedTrace,
  selectedTraceId,
  setMainView,
  tracesState,
} from "./store";

/*
 * The shell's keyboard (plan 3.9): which keymap scopes are live, and the global, list and subject
 * keys. Other work packages register their own keys (trace: f o t z 0; canvas: [ ] / n N) in their
 * components. One window keydown listener (app.tsx) calls `onShellKeydown`, which dispatches through
 * state/keymap, so the `?` sheet, the action bar and the palette all read the same registry.
 */

/* --------------------------------------------------------------------- scopes */

/** Scopes from the route and the focused element. Pure apart from reading `document.activeElement`. */
export function scopesFor(r: Route, focused: Element | null): Set<KeyScope> {
  const next = new Set<KeyScope>();
  // Views with a keyboard list (Overview routes, Requests, Queries, Changes); their list keys guard on which list is shown.
  if (
    r.view === "overview" ||
    r.view === "requests" ||
    r.view === "trace" ||
    r.view === "compare" ||
    r.view === "queries" ||
    r.view === "changes"
  )
    next.add("list");
  if (r.view === "trace" || r.view === "compare") next.add("subject");
  if ((r.view === "overview" && r.routeKey) || (r.view === "queries" && r.shape)) next.add("subject");
  if (r.view === "trace") {
    next.add("trace");
    if (focused?.closest?.('[data-key-scope="canvas"]')) next.add("canvas");
  }
  return next;
}

function syncScopes(): void {
  const next = scopesFor(route.peek(), typeof document === "undefined" ? null : document.activeElement);
  const cur = activeScopes.peek();
  if (cur.size !== next.size || [...next].some((s) => !cur.has(s))) activeScopes.value = next;
}

/* ---------------------------------------------------------------- list/subject */

/**
 * j/k: move through the list; with a request open the subject follows (history is replaced, not
 * pushed, so Back still leaves the list in one step). Starts from the open request when there is no
 * cursor yet.
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

function targetEl(e?: KeyboardEvent): HTMLElement | null {
  const t = e?.target as HTMLElement | null | undefined;
  return t && typeof t.closest === "function" ? t : null;
}

/* ---------------------------------------------------------------------- edits */

/** Dev-rebuild epochs: the server's edits (/api/epochs) plus any seen on a retained request, ascending. */
function knownEpochs(): number[] {
  return knownEpochIds(epochList.value, tracesState.value);
}

/** Edits after the session start (epoch 0 is the whole session: scoping to it would hide nothing). Pure. */
export function editsOnly(epochs: readonly number[]): number[] {
  return epochs.filter((e) => e > 0);
}

function knownEdits(): number[] {
  return editsOnly(knownEpochs());
}

function sinceNum(): number | undefined {
  const s = route.peek().since;
  if (s === undefined) return undefined;
  const n = Number(s.split(":").pop());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Where `e` (older) / `E` (newer) moves the since scope. Pure. `cur` undefined = no scope.
 * Returns the new epoch, null to clear the scope, or undefined when there is nowhere to go.
 */
export function stepEpoch(epochs: readonly number[], cur: number | undefined, dir: -1 | 1): number | null | undefined {
  if (epochs.length === 0) return undefined;
  if (cur === undefined) return dir < 0 ? epochs[epochs.length - 1] : undefined;
  if (dir < 0) {
    for (let i = epochs.length - 1; i >= 0; i--) if ((epochs[i] as number) < cur) return epochs[i];
    return undefined;
  }
  for (const e of epochs) if (e > cur) return e;
  return null; // past the newest edit: no scope
}

function moveSince(dir: -1 | 1): void {
  const next = stepEpoch(knownEdits(), sinceNum(), dir);
  if (next === undefined) return;
  setSince(next === null ? undefined : String(next));
}

/* --------------------------------------------------------------------- escape */

/**
 * An open popup whose owner closes it on Escape from its own document listener (which runs before
 * the window listener and doesn't preventDefault): the copy menu and the time-bar popover (TraceHeader's
 * budget segments), both aria-haspopup, and the query-bar suggestions (combobox). Plain disclosure
 * toggles (tree rows, "more") stay expanded and must not swallow Esc, so this is not a bare
 * [aria-expanded="true"].
 */
const POPUP_OPEN = '[aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]';

/**
 * Whether a popup was open when this keydown started. The owners' document listeners close the
 * popup and Preact re-renders in the microtask checkpoint between listeners, so by the time the
 * window listener runs the DOM no longer shows it: a capture-phase listener (initShellKeys) takes
 * the snapshot first.
 */
let popupSnap: { e: KeyboardEvent; open: boolean } | null = null;

function snapPopups(e: KeyboardEvent): void {
  popupSnap = e.key === "Escape" ? { e, open: !!document.querySelector(POPUP_OPEN) } : null;
}

function popupOpenAt(e?: KeyboardEvent): boolean {
  if (e && popupSnap?.e === e) return popupSnap.open;
  return typeof document !== "undefined" && !!document.querySelector(POPUP_OPEN);
}

/**
 * Esc (plan 3.9): close the drawer, then clear the search or scope, then go back (close the
 * subject). Returns the step to run, or null when Esc has nothing to do here: a dialog or an open
 * menu owns the key, so this one stays out of its way.
 */
function escapeStep(e?: KeyboardEvent): (() => void) | null {
  const el = targetEl(e);
  if (el?.closest("dialog")) return null;
  if (popupOpenAt(e)) return null;
  const r = route.peek();
  if (builderOpen.peek()) return closeBuilder;
  if (r.view === "trace" && (highlight.peek() || selectedHopId.peek())) {
    return () =>
      batch(() => {
        clearHighlight();
        selectHop(null);
      });
  }
  if (logQuery.peek().trim()) {
    return () => {
      logQuery.value = "";
    };
  }
  if (r.since) return () => setSince(undefined);
  if (r.view === "trace" || r.view === "compare") return closeSubject;
  if (r.view === "overview" && r.routeKey) return () => go({ view: "overview" });
  if (r.view === "queries" && r.shape) return closeShape;
  return null;
}

/* ------------------------------------------------------------------- list rail */

/** The Split id of the view on screen, when it has a subject (the rail only exists beside one). */
function railTarget(): string | null {
  const r = route.peek();
  const v = mainView.peek();
  if (v === "overview") return r.view === "overview" && r.routeKey ? v : null;
  if (v === "queries") return r.view === "queries" && r.shape ? "queries-shapes" : null;
  if (v === "requests") return r.view === "trace" || r.view === "compare" || builderOpen.peek() ? v : null;
  return null;
}

/* ------------------------------------------------------------------ wiring */

const VIEW_KEYS: ReadonlyArray<[string, MainView, string]> = [
  ["1", "overview", "Overview"],
  ["2", "requests", "Requests"],
  ["3", "queries", "Queries"],
  ["4", "changes", "Changes"],
];

/** The window keydown listener's body. */
export function onShellKeydown(e: KeyboardEvent): void {
  handleKeydown(e);
}

/** Install scope tracking and the shell's keys. Returns the disposer. */
export function initShellKeys(): () => void {
  const onFocus = () => syncScopes();
  // focusout fires before the next element has focus; read it once focus settled.
  const onBlur = () => setTimeout(syncScopes, 0);
  document.addEventListener("focusin", onFocus);
  document.addEventListener("focusout", onBlur);
  window.addEventListener("keydown", snapPopups, true);
  const stopRoute = effect(() => {
    route.value;
    syncScopes();
  });
  // The palette and the cheatsheet hold the keyboard while open.
  const stopModal = effect(() => {
    modalScope.value = paletteOpen.value || cheatsheetOpen.value ? "palette" : null;
  });

  const offs = [
    register("global", "Mod+k", "Command palette: find a route, request, finding, query or action", togglePalette, {
      inInput: true,
      overModal: true,
      palette: false,
      bar: true,
      hint: "palette",
    }),
    register("global", "?", "Keyboard shortcuts", toggleCheatsheet, { overModal: true, bar: true, hint: "keys" }),
    ...VIEW_KEYS.map(([key, view, label]) =>
      register("global", key, `Go to ${label}`, () => setMainView(view), { palette: false, hint: label.toLowerCase() }),
    ),
    register(
      "global",
      "/",
      "Filter the list",
      () => {
        const input = document.getElementById(QUERY_INPUT_MAIN) as HTMLInputElement | null;
        input?.focus();
        input?.select();
      },
      { hint: "filter" },
    ),
    register(
      "global",
      "Escape",
      "Close the drawer, then clear the filter or scope, then close the subject",
      (e) => escapeStep(e)?.(),
      { when: (e) => escapeStep(e) !== null, palette: false, bar: true, hint: "back" },
    ),
    register(
      "global",
      "s",
      "Toggle the since-last-edit scope",
      () => {
        const epochs = knownEdits();
        const last = epochs[epochs.length - 1];
        if (route.peek().since !== undefined) setSince(undefined);
        else if (last !== undefined) setSince(String(last));
      },
      { when: () => route.peek().since !== undefined || knownEdits().length > 0, hint: "since edit" },
    ),
    register("global", "e", "Scope to the previous (older) edit", () => moveSince(-1), {
      when: () => stepEpoch(knownEdits(), sinceNum(), -1) !== undefined,
      hint: "older edit",
    }),
    register("global", "E", "Scope to the next (newer) edit", () => moveSince(1), {
      when: () => stepEpoch(knownEdits(), sinceNum(), 1) !== undefined,
      hint: "newer edit",
    }),
    register(
      "global",
      "b",
      "Open / close the request builder",
      () => {
        if (builderOpen.peek()) closeBuilder();
        else {
          const t = selectedTrace.peek();
          openBuilder(t ? { method: t.method, route: t.route, path: t.path } : undefined);
        }
      },
      { hint: "builder" },
    ),
    register(
      "global",
      "Mod+\\",
      "Collapse / expand the list",
      () => {
        const id = railTarget();
        if (id) toggleListRail(id);
      },
      { when: () => railTarget() !== null, hint: "collapse list" },
    ),
    register("list", "j", "Next request (the open one follows)", () => moveSelection(1), {
      when: logVisible,
      hint: "move",
    }),
    register("list", "k", "Previous request (the open one follows)", () => moveSelection(-1), {
      when: logVisible,
      hint: "move",
    }),
    // Arrows on a focused log row are j/k (the canvas and other widgets own the arrows elsewhere).
    register("list", "ArrowDown", "Next request", () => moveSelection(1), {
      when: (e) => logVisible() && !!targetEl(e)?.closest("[data-trace-id]"),
      hidden: true,
      palette: false,
    }),
    register("list", "ArrowUp", "Previous request", () => moveSelection(-1), {
      when: (e) => logVisible() && !!targetEl(e)?.closest("[data-trace-id]"),
      hidden: true,
      palette: false,
    }),
    register("list", "Enter", "Open the request under the cursor", () => void openCursor(), {
      when: (e) => {
        if (!logVisible()) return false;
        if (targetEl(e)?.closest("button, a, [role=tab], summary, [role=separator]")) return false;
        const id = logCursor.peek();
        const r = route.peek();
        // The open request is already the subject: Enter on it has nothing to open.
        if (!id || (r.view === "trace" && r.traceId === id)) return false;
        return logRows.peek().some((t) => t.id === id);
      },
      hint: "open",
    }),
    register("subject", "[", "Newer request", () => stepSubject(-1), {
      when: () => route.peek().view === "trace",
      hint: "newer/older",
    }),
    register("subject", "]", "Older request", () => stepSubject(1), {
      when: () => route.peek().view === "trace",
      hint: "newer/older",
    }),
  ];

  return () => {
    for (const off of offs) off();
    stopRoute();
    stopModal();
    modalScope.value = null;
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("focusout", onBlur);
    window.removeEventListener("keydown", snapPopups, true);
    popupSnap = null;
  };
}
