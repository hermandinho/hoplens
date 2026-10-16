import { highlight } from "../state/canvas";
import { selectedHopId } from "../state/journey";
import {
  type BarHint,
  activeScopes,
  barHints,
  bindings,
  modalScope,
  runBinding,
  usableBindings,
} from "../state/keymap";
import { logCursor, logQuery } from "../state/requestLog";
import { route } from "../state/router";
import { builderOpen, liveStatus, tracesState } from "../state/store";

/*
 * The footer action bar (plan 3.2, 3.8): one line of the keys that work right now, generated from
 * state/keymap (so a hint is only shown when its key does something here), each one also a button.
 * Right side: requests retained and the live connection.
 */

const LIVE_LABEL = { live: "live", reconnecting: "reconnecting…", offline: "offline" } as const;

export function ActionBar() {
  // Subscriptions: the bindings' `when` guards read these with peek(), so read them here to re-render
  // when what is usable changes.
  bindings.value;
  activeScopes.value;
  modalScope.value;
  route.value;
  builderOpen.value;
  logQuery.value;
  logCursor.value;
  highlight.value;
  selectedHopId.value;
  const n = tracesState.value.length;
  const live = liveStatus.value;

  const hints = barHints(usableBindings());

  // Context hints come first and give way when the bar is narrow (a hint that does not fit wraps to a
  // hidden second line, never half-clipped); the few globals (palette, ?, Esc) are pinned so they
  // always show (r2 visual: at 1280 "Esc back" was clipped under the status).
  const context = hints.filter((h) => h.binding.scope !== "global");
  const pinned = hints.filter((h) => h.binding.scope === "global");

  return (
    <footer class="action-bar" aria-label="Keyboard shortcuts for this view">
      <ul class="action-bar-hints">{context.map(renderHint)}</ul>
      {pinned.length > 0 && <ul class="action-bar-hints action-bar-pinned">{pinned.map(renderHint)}</ul>}
      <span class="action-bar-status mono dim">
        {n} request{n === 1 ? "" : "s"}
        <span class={`action-bar-live action-bar-live-${live}`} aria-hidden="true" />
        {LIVE_LABEL[live]}
      </span>
    </footer>
  );
}

function renderHint(h: BarHint) {
  return (
    <li key={`${h.binding.scope}:${h.binding.key}`}>
      <button type="button" class="action-bar-hint" title={h.binding.label} onClick={() => runBinding(h.binding)}>
        {h.keys.map((k, i) => (
          <span key={k}>
            {i > 0 && <span class="dim">/</span>}
            <kbd>{k}</kbd>
          </span>
        ))}{" "}
        <span class="action-bar-label">{h.hint}</span>
      </button>
    </li>
  );
}
