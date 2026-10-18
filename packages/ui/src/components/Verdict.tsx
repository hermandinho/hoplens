import { useEffect, useMemo, useState } from "preact/hooks";
import type { Finding, TraceRecord } from "../api/types";
import { clearHighlight, highlight, setHighlight, zoomTo } from "../state/canvas";
import { ruleLabel } from "../state/framework";
import { register } from "../state/keymap";
import { openSourceAt } from "../state/source";
import { fmtMs } from "../state/stats";
import { frameworkCopy } from "../state/store";
import { type Verdict as VerdictModel, findingSentence, fullLoc, shortLoc, verdictFor } from "../state/verdict";
import { InlineSource } from "./SourcePeek";
import "../styles/verdict.css";

/*
 * The verdict line (plan 3.2 / 3.7): one 20px sentence naming the cause, then the saving and the
 * culprit's file:line, an inline +-2 line source peek and the actions. Clicking it (or `f`)
 * highlights the cause's spans on the canvas (dimming the rest, never hiding them); a cold verdict
 * zooms the canvas to the handler instead. `o` opens the culprit in the source viewer.
 */

function reasonOf(v: VerdictModel): string {
  return v.finding ? `finding:${v.finding.rule}` : `verdict:${v.rule}`;
}

/** Highlight (or, when already highlighted, clear) the verdict's spans; zoom for a cold wait. */
function act(v: VerdictModel): void {
  if (v.zoom) zoomTo(v.zoom);
  if (v.spanIds.length === 0) return;
  const reason = reasonOf(v);
  if (highlight.value?.reason === reason) clearHighlight();
  else setHighlight(v.spanIds, reason);
}

export function Verdict({ trace }: { trace: TraceRecord }) {
  const fw = frameworkCopy.value;
  const v = useMemo(() => verdictFor(trace, fw), [trace, fw]);
  // The line the inline peek marked: an N+1's call site rather than its function's declaration.
  const [hitLine, setHitLine] = useState<number | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the culprit changes
  useEffect(() => setHitLine(undefined), [v.location?.file, v.location?.line, v.callee]);
  const loc = v.location ? { ...v.location, line: hitLine ?? v.location.line } : undefined;

  // `f`: jump to the verdict's cause; `o`: open the culprit. Scope "trace" is active while a trace
  // is the subject (the shell decides).
  // biome-ignore lint/correctness/useExhaustiveDependencies: loc is derived from v and hitLine
  useEffect(() => {
    const offs = [register("trace", "f", "Highlight the verdict's cause", () => act(v))];
    if (loc) offs.push(register("trace", "o", "Open the culprit's source", () => openSourceAt(loc.file, loc.line)));
    return () => {
      for (const off of offs) off();
    };
  }, [v, hitLine]);

  // A different trace starts without the previous trace's highlight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup must run when the trace changes
  useEffect(() => {
    return () => {
      if (highlight.value?.reason.startsWith("finding:") || highlight.value?.reason.startsWith("verdict:"))
        clearHighlight();
    };
  }, [trace.id]);

  const active = highlight.value?.reason === reasonOf(v);
  const note =
    v.repeat && v.repeat > 1
      ? `x${v.repeat}${v.perCallMs !== undefined ? `, ${fmtMs(v.perCallMs)} each` : ""}`
      : undefined;
  const peek = loc && (v.rule === "finding" || v.rule === "error" || v.rule === "swallowed");
  const canAct = v.spanIds.length > 0 || !!v.zoom;

  return (
    <section class={`verdict verdict-${v.tone}`} aria-label="Verdict">
      {canAct ? (
        <button
          type="button"
          class={`verdict-text t-hero ${active ? "active" : ""}`}
          onClick={() => act(v)}
          aria-pressed={v.spanIds.length > 0 ? active : undefined}
          title={v.zoom ? "Zoom the canvas to the handler (f)" : "Highlight these spans on the canvas (f)"}
        >
          {v.text}
        </button>
      ) : (
        <p class="verdict-text t-hero">{v.text}</p>
      )}
      {(v.saveableMs !== undefined || loc) && (
        <div class="verdict-meta">
          {v.saveableMs !== undefined && v.saveableMs >= 1 && (
            <span class="verdict-save mono">~{fmtMs(v.saveableMs)} saveable</span>
          )}
          {loc && (
            <button
              type="button"
              class="src-link mono verdict-loc"
              onClick={() => openSourceAt(loc.file, loc.line)}
              title="Open in source viewer (o)"
            >
              {fullLoc(loc)}
            </button>
          )}
        </div>
      )}
      {peek && v.location && (
        <InlineSource
          file={v.location.file}
          line={v.location.line}
          note={note}
          seek={v.location.via === "call-site" ? undefined : v.callee}
          rev={trace.facts?.epoch ?? ""}
          onResolve={setHitLine}
        />
      )}
      {canAct && (
        <div class="verdict-actions">
          <button type="button" class="sbtn" onClick={() => act(v)} aria-pressed={active}>
            <kbd>f</kbd> {v.zoom ? "zoom to handler" : active ? "clear highlight" : "highlight"}
          </button>
          {loc && (
            <button type="button" class="sbtn" onClick={() => openSourceAt(loc.file, loc.line)}>
              <kbd>o</kbd> open {shortLoc(loc)}
            </button>
          )}
        </div>
      )}
      <MoreFindings key={trace.id} trace={trace} shown={v.finding} />
    </section>
  );
}

/** The trace's other findings, folded behind one line so the verdict stays the focal point. */
function MoreFindings({ trace, shown }: { trace: TraceRecord; shown?: Finding }) {
  const [open, setOpen] = useState(false);
  const fw = frameworkCopy.value;
  const rest = (trace.findings ?? [])
    .filter((f) => f !== shown)
    .sort((a, b) => (b.estSavedMs ?? 0) - (a.estSavedMs ?? 0));
  if (rest.length === 0) return null;
  return (
    <div class="verdict-more">
      <button type="button" class="verdict-more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {rest.length} {shown ? "more " : ""}finding{rest.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul class="verdict-more-list">
          {rest.map((f, i) => {
            const reason = `finding:${f.rule}:${f.fingerprint}`;
            const on = highlight.value?.reason === reason;
            return (
              <li key={`${f.fingerprint}-${i}`} class={`verdict-more-item sev-rule-${f.severity}`}>
                <button
                  type="button"
                  class={`verdict-more-row ${on ? "active" : ""}`}
                  disabled={f.spanIds.length === 0}
                  aria-pressed={f.spanIds.length > 0 ? on : undefined}
                  onClick={() => (on ? clearHighlight() : setHighlight(f.spanIds, reason))}
                  title={f.detail ?? f.title}
                >
                  <span class={`sev-dot sev-${f.severity}`} aria-hidden="true" />
                  <span class="verdict-more-rule">{ruleLabel(f.rule, fw)}</span>
                  <span class="verdict-more-text">{findingSentence(f, trace.spans, undefined, fw)}</span>
                  {f.estSavedMs !== undefined && f.estSavedMs >= 1 && (
                    <span class="mono dim">~{fmtMs(f.estSavedMs)}</span>
                  )}
                </button>
                {f.location && (
                  <button
                    type="button"
                    class="src-link mono verdict-more-loc"
                    onClick={() => openSourceAt(f.location!.file, f.location!.line)}
                    title={fullLoc(f.location)}
                  >
                    {shortLoc(f.location)}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
