import type { FindingSeverity, TimeBucket } from "../api/types";
import { BUCKETS, BUCKET_LABELS, SMALL_SAMPLE, approx, fmtMs } from "../state/stats";

/*
 * Small hand-rolled chart primitives shared by the Overview, the route subject and the request list.
 * No sparklines: at dev volume a 2-3 point line is noise (plan 3.3); the d-epoch column replaces them.
 * No chart library, no external assets: plain SVG/CSS so the UI stays one inlined HTML file.
 * Bucket colors come from the --b-* tokens in tokens.css so every surface uses one legend.
 */

/** 100%-stacked horizontal bar of self-time per bucket. Width comes from the parent. */
export function MixBar({
  time,
  class: cls = "",
}: {
  time: Record<TimeBucket, number> | undefined;
  class?: string;
}) {
  if (!time) return <span class={`mix-bar mix-bar-empty ${cls}`} title="No timing facts for this request" />;
  const total = BUCKETS.reduce((s, b) => s + (time[b] ?? 0), 0);
  if (total <= 0) return <span class={`mix-bar mix-bar-empty ${cls}`} />;
  const title = BUCKETS.filter((b) => (time[b] ?? 0) > 0)
    .map((b) => `${BUCKET_LABELS[b]} ${Math.round(((time[b] ?? 0) / total) * 100)}%`)
    .join(" · ");
  return (
    <span class={`mix-bar ${cls}`} title={title} role="img" aria-label={`Time mix: ${title}`}>
      {BUCKETS.map((b) => {
        const v = time[b] ?? 0;
        if (v <= 0) return null;
        return <span key={b} class={`mix-seg b-${b}`} style={{ width: `${(v / total) * 100}%` }} />;
      })}
    </span>
  );
}

/** A percentile with its sample size; greyed and "~"-prefixed when the sample is small. */
export function Pctl({ value, n, showN = false }: { value: number | undefined; n: number; showN?: boolean }) {
  const small = n < SMALL_SAMPLE;
  return (
    <span
      class={`pctl mono ${small ? "pctl-small" : ""}`}
      title={
        n === 0 ? "No samples" : small ? `Only ${n} sample${n === 1 ? "" : "s"}: treat as a rough guide` : `n=${n}`
      }
    >
      {value === undefined ? "—" : `${approx(n)}${fmtMs(value)}`}
      {showN && <span class="pctl-n">n={n}</span>}
    </span>
  );
}

export function SevBadge({
  severity,
  count,
  label,
}: {
  severity: FindingSeverity | undefined;
  count: number;
  label?: string;
}) {
  if (!severity || count <= 0) return null;
  return (
    <span
      class={`sev-badge sev-${severity}`}
      title={label ?? `${count} finding${count === 1 ? "" : "s"} (worst: ${severity})`}
    >
      <span class="sev-dot" aria-hidden="true" />
      {count}
    </span>
  );
}
