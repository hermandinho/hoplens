import { setSince } from "../state/router";
import { scopeLabel, sinceEpoch } from "../state/sinceScope";
import "../styles/changes.css";

/**
 * The explicit "since e7 store.ts ×" chip (plan 3.8). Every list that applies the since scope draws
 * it in its header, so a scoped list never looks like the whole session. `detail` says what the list
 * now counts ("12/40"); `title` says how.
 */
export function SinceChip({ detail, title }: { detail?: string; title?: string }) {
  const since = sinceEpoch.value;
  if (since === undefined) return null;
  return (
    <span
      class="scope-chip"
      title={`${title ?? `Scoped to edit e${since} and later.`} Esc, s or × clears it; e / E step to an older / newer edit.`}
    >
      since {scopeLabel(since)}
      {detail && <span class="scope-chip-n mono">{detail}</span>}
      <button type="button" class="scope-chip-x" aria-label="Clear the since scope" onClick={() => setSince(undefined)}>
        ×
      </button>
    </span>
  );
}
