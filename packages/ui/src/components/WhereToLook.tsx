import { useMemo, useState } from "preact/hooks";
import type { TraceRecord } from "../api/types";
import { clearHighlight, highlight, setHighlight } from "../state/canvas";
import { ruleLabel } from "../state/framework";
import { selectHop } from "../state/journey";
import { BUCKET_LABELS, fmtMs } from "../state/stats";
import { frameworkCopy } from "../state/store";
import { type LookGroup, fullLoc, lookGroups, shortLoc } from "../state/verdict";
import { InlineSource } from "./SourcePeek";
import "../styles/verdict.css";

/*
 * "Where to look" (plan 3.2): the request's time, grouped. Identical I/O calls fold into one "12x"
 * row timed by the wall time they covered; other spans show their time on the critical path. Each
 * row selects its first span, highlights all of its spans on the canvas, and peeks at the source.
 */

export function WhereToLook({ trace, limit = 5 }: { trace: TraceRecord; limit?: number }) {
  const rows = useMemo(() => lookGroups(trace, limit), [trace, limit]);
  const [peek, setPeek] = useState<string | null>(null);

  return (
    <section class="look" aria-label="Where to look">
      <div class="insp-section-title">Where to look</div>
      {rows.length === 0 ? (
        <p class="dim look-note">
          {trace.done ? "Nothing stands out in this request." : "Waiting for the request to finish…"}
        </p>
      ) : (
        <ol class="look-list">
          {rows.map((r) => (
            <LookRow
              key={r.key}
              row={r}
              peeking={peek === r.key}
              rev={trace.facts?.epoch ?? ""}
              onPeek={() => setPeek(peek === r.key ? null : r.key)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function LookRow({
  row: r,
  peeking,
  rev,
  onPeek,
}: {
  row: LookGroup;
  peeking: boolean;
  rev: string | number;
  onPeek: () => void;
}) {
  const reason = `look:${r.key}`;
  const on = highlight.value?.reason === reason;
  const pct = Math.round(r.share * 100);
  const note = r.count > 1 ? `x${r.count}, ${fmtMs(r.ms / r.count)} avg` : undefined;
  return (
    <li class={`look-row ${on ? "active" : ""}`}>
      <button
        type="button"
        class="look-main"
        onClick={() => selectHop(r.spanIds[0] ?? null)}
        title={`${r.label}${r.detail ? ` ${r.detail}` : ""}\nSelect the span`}
      >
        <span class={`legend-swatch b-${r.bucket}`} aria-hidden="true" title={BUCKET_LABELS[r.bucket]} />
        <span class="look-count mono">{r.count > 1 ? `${r.count}x` : ""}</span>
        <span class="look-name">
          <span class="mono">{r.label}</span>
          {r.detail && <span class="look-detail mono dim"> {r.detail}</span>}
        </span>
        <span class="look-ms mono" title={r.detail ? "Wall time these calls covered" : "Time on the critical path"}>
          {fmtMs(r.ms)}
        </span>
        <span class="look-pct mono dim">{pct < 1 ? "<1" : pct}%</span>
        {r.location && (
          <span class="look-loc mono dim" title={fullLoc(r.location)}>
            {shortLoc(r.location)}
          </span>
        )}
        {r.rule && <span class="look-rule">{ruleLabel(r.rule, frameworkCopy.value)}</span>}
      </button>
      <span class="look-actions">
        {r.location && (
          <button type="button" class="look-act" aria-expanded={peeking} onClick={onPeek}>
            peek
          </button>
        )}
        <button
          type="button"
          class="look-act"
          aria-pressed={on}
          onClick={() => (on ? clearHighlight() : setHighlight(r.spanIds, reason))}
        >
          {on ? "clear" : "highlight"}
        </button>
      </span>
      {peeking && r.location && (
        <div class="look-peek">
          <InlineSource file={r.location.file} line={r.location.line} note={note} rev={rev} />
        </div>
      )}
    </li>
  );
}
