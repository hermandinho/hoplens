import { setSidebarTab, sidebarTab, tracesState, tracesWithErrors } from "../state/store";
import { RoutesList } from "./RoutesList";
import { TrafficList } from "./TrafficList";

export function Sidebar() {
  const tab = sidebarTab.value;
  const trafficCount = tracesState.value.length;
  const errCount = tracesWithErrors.value;

  return (
    <aside class="side" aria-label="Routes and traffic">
      <div class="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
        <button
          type="button"
          role="tab"
          class={`sidebar-tab ${tab === "routes" ? "active" : ""}`}
          aria-selected={tab === "routes"}
          onClick={() => setSidebarTab("routes")}
        >
          Routes
        </button>
        <button
          type="button"
          role="tab"
          class={`sidebar-tab ${tab === "traffic" ? "active" : ""}`}
          aria-selected={tab === "traffic"}
          onClick={() => setSidebarTab("traffic")}
        >
          Traffic
          {trafficCount > 0 && <span class="tab-count">{trafficCount}</span>}
          {errCount > 0 && (
            <span class="tab-count tab-count-err" aria-label={`${errCount} with errors`}>
              {errCount}
            </span>
          )}
        </button>
      </div>
      <div class={`sidebar-body ${tab === "traffic" ? "sidebar-body-traffic" : ""}`} role="tabpanel">
        {tab === "routes" ? <RoutesList /> : <TrafficList />}
      </div>
    </aside>
  );
}
