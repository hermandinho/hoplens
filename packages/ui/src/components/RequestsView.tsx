import { QUERY_INPUT_MAIN, logQuery, logRows } from "../state/requestLog";
import { statsSource, tracesState } from "../state/store";
import { QueryBar, RequestLog } from "./RequestLog";

/** The Requests view: the dense request log with every column, full width. */
export function RequestsView() {
  const total = tracesState.value.length;
  const shown = logRows.value.length;
  const filtered = logQuery.value.trim() !== "";
  return (
    <section class="requests-view" aria-labelledby="requests-title">
      <header class="ov-head rv-head">
        <div>
          <h2 id="requests-title" class="ov-title">
            Requests {total > 0 && <span class="count">{filtered ? `${shown} of ${total}` : total}</span>}
          </h2>
          <div class="ov-sub dim">
            Every retained request, newest first. <kbd>/</kbd> search, <kbd>j</kbd> <kbd>k</kbd> move, <kbd>Enter</kbd>{" "}
            opens. Duration bars are scaled to each route's warm p95
            {statsSource.value === "server" ? " (server stats)" : " (this tab's stats)"}.
          </div>
        </div>
      </header>
      <QueryBar id={QUERY_INPUT_MAIN} variant="dense" />
      <RequestLog variant="dense" label="Requests" />
    </section>
  );
}
