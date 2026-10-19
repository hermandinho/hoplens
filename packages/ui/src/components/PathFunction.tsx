import { useEffect, useRef } from "preact/hooks";
import type { PathPayload } from "../api/types";
import { pathMode } from "../state/canvas";
import { register } from "../state/keymap";
import { isMobile } from "../state/mobile";
import {
  type PanelState,
  crumbs,
  evidenceText,
  flowUnavailable,
  fnCalls,
  panelDo,
  pathPanel,
  viewFor,
} from "../state/pathPanel";
import { PathFlow } from "./PathFlow";
import { PathSource } from "./PathSource";

/*
 * The function panel of Path mode (plan P4): one function of the path payload, as a flowchart
 * (Flow) or its source with a count gutter (Source). Beside the trail at >= 1100px, in its place
 * (behind the breadcrumb) below. v toggles Flow / Source, u unfolds, Backspace goes back, Esc closes.
 */

const live = () => pathMode.value && !!pathPanel.value;

export function PathFunction({ payload, state }: { payload: PathPayload; state: PanelState }) {
  const fnKey = state.stack[state.stack.length - 1]!;
  const fn = payload.functions[fnKey];
  const view = viewFor(state, payload, fn, isMobile.value);
  const noFlow = flowUnavailable(payload, fn);
  const names = crumbs(payload, state.stack);
  const head = useRef<HTMLHeadingElement>(null);
  const cur = useRef({ view, noFlow });
  cur.current = { view, noFlow };

  useEffect(() => {
    const opts = { when: live };
    const offs = [
      register("canvas", "Escape", "Close the function panel", () => panelDo({ t: "close" }), {
        ...opts,
        hint: "close",
      }),
      register("canvas", "Backspace", "Back to the caller (or the trail)", () => panelDo({ t: "back" }), {
        ...opts,
        hint: "back",
      }),
      register(
        "canvas",
        "v",
        "Toggle Flow / Source of the function",
        () => {
          if (cur.current.noFlow) return;
          panelDo({ t: "view", view: cur.current.view === "flow" ? "source" : "flow" });
        },
        { ...opts, hint: "flow/source" },
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  if (!fn)
    return (
      <section class="path-fn" aria-label="Function">
        <p class="path-note">This function is not in the path payload.</p>
      </section>
    );
  const unknown = fn.analysis?.status === "unknown" ? noFlow : null;
  const calls = fnCalls(fn);
  return (
    <section class="path-fn" aria-label={`Function ${fn.name}`}>
      <nav class="path-crumbs" aria-label="Breadcrumb">
        <ol>
          {names.map((n, i) => (
            <li key={`${i}${n}`}>
              {i < names.length - 1 ? (
                <button type="button" class="link-btn" onClick={() => panelDo({ t: "crumb", depth: i - 1 })}>
                  {n}
                </button>
              ) : (
                <span aria-current="page">{n}</span>
              )}
            </li>
          ))}
        </ol>
        <button
          type="button"
          class="sbtn path-fn-close"
          onClick={() => panelDo({ t: "close" })}
          aria-label="Close the function panel"
          title="Close (Esc)"
        >
          x
        </button>
      </nav>
      <div class="path-fn-head">
        <h3 ref={head} tabIndex={-1} class="mono">
          {fn.name || "(anonymous)"}
        </h3>
        <span class="mono dim">
          {fn.file}:{fn.startLine ?? fn.line}
        </span>
        <span class="mono dim">x{calls}</span>
        <fieldset class="tc-mode path-fn-view">
          <legend class="sr-only">Function view (v toggles)</legend>
          {(["flow", "source"] as const).map((v) => (
            <button
              key={v}
              type="button"
              class={`chip tc-mode-btn ${view === v ? "chip-active" : ""}`}
              aria-pressed={view === v}
              disabled={v === "flow" && !!noFlow}
              title={
                v === "flow" && noFlow
                  ? `No flowchart: ${noFlow}`
                  : `${v === "flow" ? "Flowchart" : "Source with counts"} (v)`
              }
              onClick={() => panelDo({ t: "view", view: v })}
            >
              {v === "flow" ? "Flow" : "Source"}
            </button>
          ))}
        </fieldset>
      </div>
      {unknown && <p class="path-note path-fn-unknown">{unknown}</p>}
      {view === "flow" ? (
        <PathFlow
          key={fnKey}
          payload={payload}
          fn={fn}
          line={state.line}
          startKey={state.focus}
          autoFocus
          onOpen={(k, from) => panelDo({ t: "push", fnKey: k, from })}
        />
      ) : (
        <PathSource key={fnKey} payload={payload} fn={fn} line={state.line} autoFocus />
      )}
      <footer class="path-evidence dim mono">evidence: {evidenceText(payload, fn)}</footer>
    </section>
  );
}
