import { useEffect } from "preact/hooks";
import { type CanvasMode, canvasMode, setCanvasMode, showCritical, toggleCritical } from "../state/canvas";
import { register } from "../state/keymap";
import { selectedTrace, tracesState } from "../state/store";
import { JourneyWaterfall } from "./JourneyWaterfall";

/** The span canvas (Flame or Tree) for the selected request. */
export function JourneyPane() {
  const trace = selectedTrace.value;
  const spans = trace?.spans.length ?? 0;
  // The list summary can be ahead of the loaded record while a late-span reload is in flight.
  const summary = trace ? tracesState.value.find((t) => t.id === trace.id) : undefined;
  const dropped = Math.max(trace?.facts?.droppedSpans ?? 0, summary?.facts?.droppedSpans ?? 0);
  const mode = canvasMode.value;
  useEffect(
    () =>
      register("trace", "t", "Toggle tree / flame", () =>
        setCanvasMode(canvasMode.value === "flame" ? "tree" : "flame"),
      ),
    [],
  );
  return (
    <section class="journey-pane" aria-label="Journey">
      <header class="journey-pane-head">
        <div class="journey-pane-title">Journey</div>
        {trace && (
          <div class="journey-pane-meta dim mono">
            {spans} span{spans === 1 ? "" : "s"}
            {dropped > 0 && (
              <span
                class="journey-pane-warn"
                title="Spans that ended after the response finished (after(), un-awaited work). Shown in the timeline with a 'late' tag, not counted in the facts or findings."
              >
                {" "}
                · {dropped} late
              </span>
            )}
            {trace.facts?.truncated && (
              <span class="journey-pane-warn" title="Analysis stopped at the span cap">
                {" "}
                · analysis truncated
              </span>
            )}
          </div>
        )}
        {trace && (
          <div class="tc-controls">
            <button
              type="button"
              class={`chip tc-crit-toggle ${showCritical.value ? "chip-active" : ""}`}
              aria-pressed={showCritical.value}
              onClick={toggleCritical}
              title="Outline the critical path: the chain of spans the end of the request waited on"
            >
              <span class="tc-crit-swatch" aria-hidden="true" />
              Critical path
            </button>
            <fieldset class="tc-mode">
              <legend class="sr-only">Canvas mode</legend>
              {(["flame", "tree"] as CanvasMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  class={`chip tc-mode-btn ${mode === m ? "chip-active" : ""}`}
                  aria-pressed={mode === m}
                  onClick={() => setCanvasMode(m)}
                  title={
                    m === "flame"
                      ? "Flame: nested boxes, width = duration (t toggles)"
                      : "Tree: one indented row per span, collapsible (t toggles)"
                  }
                >
                  {m === "flame" ? "Flame" : "Tree"}
                </button>
              ))}
            </fieldset>
          </div>
        )}
      </header>
      <div class="journey-pane-body">
        <JourneyWaterfall />
      </div>
    </section>
  );
}
