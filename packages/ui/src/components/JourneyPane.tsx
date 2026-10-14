import { signal } from "@preact/signals";
import { Journey } from "./Journey";
import { JourneyWaterfall } from "./JourneyWaterfall";

/**
 * View-mode toggle between the horizontal "flow" layout (original, SVG-based)
 * and the new "waterfall" layout (time-proportional, Jaeger-style). Users can
 * flip between them to compare — persisted in localStorage so a reload keeps
 * their choice.
 */

type JourneyView = "waterfall" | "flow";
const STORAGE_KEY = "hoplens.journeyView";

function loadInitial(): JourneyView {
  if (typeof localStorage === "undefined") return "waterfall";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "flow" || stored === "waterfall" ? stored : "waterfall";
}

const journeyView = signal<JourneyView>(loadInitial());

function setView(v: JourneyView) {
  journeyView.value = v;
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, v);
}

export function JourneyPane() {
  const view = journeyView.value;
  return (
    <section class="journey-pane" aria-label="Journey">
      <header class="journey-pane-head">
        <div class="journey-pane-title">Journey</div>
        <div class="journey-view-toggle" role="tablist" aria-label="Journey view mode">
          <button
            type="button"
            role="tab"
            aria-selected={view === "waterfall"}
            class={`view-btn ${view === "waterfall" ? "active" : ""}`}
            onClick={() => setView("waterfall")}
          >
            Waterfall
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "flow"}
            class={`view-btn ${view === "flow" ? "active" : ""}`}
            onClick={() => setView("flow")}
          >
            Flow
          </button>
        </div>
      </header>
      <div class="journey-pane-body">{view === "waterfall" ? <JourneyWaterfall /> : <Journey />}</div>
    </section>
  );
}
