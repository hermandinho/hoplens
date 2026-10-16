import type { FindingSeverity, TimeBucket } from "../api/types";
import { BUCKETS, BUCKET_LABELS, SMALL_SAMPLE, approx, fmtMs } from "../state/stats";

/*
 * Small hand-rolled chart primitives shared by the Overview, sidebar and traffic list.
 * No chart library, no external assets: plain SVG/CSS so the UI stays one inlined HTML file.
 * Bucket colors come from the --b-* tokens in tokens.css so every surface uses one legend.
 */

/** Sparkline over a series with gaps (undefined). Draws a line per contiguous run plus a soft area. */
export function Sparkline({
  values,
  label,
  tone = "neutral",
}: {
  values: Array<number | undefined>;
  label: string;
  tone?: "neutral" | "err";
}) {
  const defined = values.filter((v): v is number => v !== undefined);
  if (values.length < 2 || defined.length < 2) return <div class="spark spark-empty" aria-hidden="true" />;
  const max = Math.max(...defined);
  const min = Math.min(0, ...defined);
  const range = max - min || 1;
  const W = 100;
  const H = 24;
  const step = W / (values.length - 1);
  const y = (v: number) => H - 2 - ((v - min) / range) * (H - 4);

  const runs: string[][] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v === undefined) {
      if (cur.length) runs.push(cur);
      cur = [];
      return;
    }
    cur.push(`${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  });
  if (cur.length) runs.push(cur);

  return (
    <svg
      class={`spark spark-${tone}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {runs.map((pts) => {
        if (pts.length === 1) {
          const [x, yy] = (pts[0] as string).split(",");
          return <circle key={pts[0]} cx={x} cy={yy} r="1.2" class="spark-dot" />;
        }
        const first = (pts[0] as string).split(",")[0];
        const last = (pts[pts.length - 1] as string).split(",")[0];
        return (
          <g key={pts[0]}>
            <polygon class="spark-area" points={`${first},${H} ${pts.join(" ")} ${last},${H}`} />
            <polyline class="spark-line" points={pts.join(" ")} vector-effect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
}

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

export function BucketLegend() {
  return (
    <ul class="bucket-legend" aria-label="Time bucket colors">
      {BUCKETS.map((b) => (
        <li key={b}>
          <span class={`legend-swatch b-${b}`} aria-hidden="true" />
          {BUCKET_LABELS[b]}
        </li>
      ))}
    </ul>
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
