import { useEffect } from "preact/hooks";
import {
  type JourneyMode,
  canvasMode,
  openedTrace,
  pathMode,
  setCanvasMode,
  setJourneyMode,
  showCritical,
  toggleCritical,
  togglePathMode,
} from "../state/canvas";
import { register } from "../state/keymap";
import { isMobile } from "../state/mobile";
import { pathFocus, pathPayloads, stampOf } from "../state/path";
import { selectedTrace, tracesState } from "../state/store";
import { JourneyWaterfall } from "./JourneyWaterfall";
import { PathPane } from "./PathPane";

const MODE_TITLE: Record<JourneyMode, string> = {
  flame: "Flame: nested boxes, width = duration (t toggles)",
  tree: "Tree: one indented row per span, collapsible (t toggles)",
  path: "Path: which side of each decision this request took (x toggles)",
};

/** The span canvas (Flame or Tree), or the request path (Path), for the selected request. */
export function JourneyPane() {
  const trace = selectedTrace.value;
  const spans = trace?.spans.length ?? 0;
  // The list summary can be ahead of the loaded record while a late-span reload is in flight.
  const summary = trace ? tracesState.value.find((t) => t.id === trace.id) : undefined;
  const dropped = Math.max(trace?.facts?.droppedSpans ?? 0, summary?.facts?.droppedSpans ?? 0);
  const stamp = stampOf(trace, summary, trace ? pathPayloads.value.get(trace.id) : undefined);
  const phone = isMobile.value;
  const spanMode = phone ? "tree" : canvasMode.value;
  const mode: JourneyMode = pathMode.value ? "path" : spanMode;
  const isPathTrace = !!stamp;
  // biome-ignore lint/correctness/useExhaustiveDependencies: per opened trace
  useEffect(() => {
    if (trace) openedTrace(isPathTrace);
  }, [trace?.id, isPathTrace]);
  useEffect(() => {
    const offs = [
      register("trace", "t", "Toggle tree / flame", () => {
        pathMode.value = false;
        setCanvasMode(canvasMode.value === "flame" ? "tree" : "flame");
      }),
      register(
        "trace",
        "x",
        "Toggle Path mode: which side of each decision this request took",
        () => {
          togglePathMode();
          // On a path trace, move focus to its trail so j / k reach the lanes (not the request list).
          const t = selectedTrace.peek();
          if (!pathMode.peek() || !t) return;
          const sum = tracesState.peek().find((x) => x.id === t.id);
          if (stampOf(t, sum, pathPayloads.peek().get(t.id))) pathFocus.value = t.id;
        },
        { hint: "path" },
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);
  const modes: JourneyMode[] = phone ? ["tree", "path"] : ["flame", "tree", "path"];
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
            {mode !== "path" && (
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
            )}
            <fieldset class="tc-mode tc-mode-path">
              <legend class="sr-only">Canvas mode</legend>
              {modes.map((m) => (
                <button
                  key={m}
                  type="button"
                  class={`chip tc-mode-btn ${mode === m ? "chip-active" : ""}`}
                  aria-pressed={mode === m}
                  onClick={() => setJourneyMode(m)}
                  title={MODE_TITLE[m]}
                >
                  {m === "flame" ? "Flame" : m === "tree" ? "Tree" : "Path"}
                  {m === "path" && isPathTrace && (
                    <>
                      <span class="tc-path-dot" aria-hidden="true" />
                      <span class="sr-only"> (path trace)</span>
                    </>
                  )}
                </button>
              ))}
            </fieldset>
          </div>
        )}
      </header>
      <div class="journey-pane-body">
        {trace && mode === "path" ? <PathPane trace={trace} stamp={stamp} /> : <JourneyWaterfall />}
      </div>
    </section>
  );
}
