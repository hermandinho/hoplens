import { QUERY_INPUT_SIDE, logQuery, logRows } from "../state/requestLog";
import { setMainView, tracesState, tracesWithErrors } from "../state/store";
import { QueryBar, RequestLog } from "./RequestLog";

/** Sidebar Traffic tab: the compact request log under the shared query bar. */
export function TrafficList() {
  const total = tracesState.value.length;
  const shown = logRows.value.length;
  const filtered = logQuery.value.trim() !== "";
  const errs = tracesWithErrors.value;

  return (
    <section class="section section-traffic" aria-labelledby="section-traffic-title">
      <div class="section-head">
        <h2 id="section-traffic-title" class="section-title">
          Traffic{" "}
          {total > 0 && (
            <span class="count" title={filtered ? `${shown} of ${total} match the query` : undefined}>
              {filtered ? `${shown}/${total}` : total}
            </span>
          )}
          {errs > 0 && (
            <span class="count count-err" aria-label={`${errs} with 5xx errors`}>
              {errs} err
            </span>
          )}
        </h2>
        <button
          type="button"
          class="link-btn section-link"
          onClick={() => setMainView("requests")}
          title="Open the full request log with every column"
        >
          Full log
        </button>
      </div>
      <QueryBar id={QUERY_INPUT_SIDE} variant="compact" />
      <RequestLog variant="compact" label="Traffic" />
    </section>
  );
}
