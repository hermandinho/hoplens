import { useSignal } from "@preact/signals";
import type { BodyDiff, CompareResult, CompareRow, CompareSide, FindingSummary, HeadersDiff } from "../api/types";
import {
  BASELINE_LABELS,
  OP_GLYPH,
  type RowMark,
  baselinesOf,
  bucketView,
  cancelPick,
  changesOnly,
  compareDefault,
  compareKey,
  compareLoad,
  compareNotice,
  countChanges,
  countText,
  fmtDelta,
  fmtDeltaPct,
  jsonText,
  opText,
  openCompare,
  pickState,
  pinnedIds,
  retryCompare,
  rowMark,
  setPinned,
  startPick,
  togglePin,
  valueMode,
  visibleRows,
} from "../state/compare";
import { formatKey } from "../state/keymap";
import { go } from "../state/router";
import { openSourceAt } from "../state/source";
import { RULE_LABELS, fmtMs } from "../state/stats";
import { loadTrace } from "../state/store";
import { Skeleton } from "./Skeleton";
import "../styles/compare.css";

/*
 * Compare (plan 3.4): the merged diff of A (baseline) and B (subject), #/cmp/<a>..<b>. Top down:
 * both requests (pinned server-side, so rotation can't break the view), the baselines for B, the
 * one-sentence summary, bucket deltas, count changes, the span tree with matched / added / removed
 * rows and repeat changes (x10 -> x1), findings added / resolved, then the request and response
 * diffs. Red = worse, green = better, gray = unchanged; only-in-A / only-in-B carry a glyph and a
 * label, not a hue. Split mode is v2 (plan 5).
 */

/** Span rows drawn before "show all": a 1000-row diff would stall the subject pane. */
const ROW_CAP = 300;

export function CompareView({ a, b }: { a: string; b: string }) {
  const load = compareLoad.value;
  const key = compareKey(a, b);
  const cur = load?.key === key ? load : null;

  return (
    <div class="subject-body cmp">
      <Baselines a={a} b={b} />
      <PickBanner />
      {!cur || cur.status === "loading" ? (
        <div class="subject-loading">
          <Skeleton lines={6} />
        </div>
      ) : cur.status === "missing" ? (
        <Missing missing={cur.missing} b={b} />
      ) : cur.status === "error" ? (
        <p class="cmp-error" role="alert">
          Could not compare: {cur.error}{" "}
          <button type="button" class="link-btn" onClick={retryCompare}>
            Retry
          </button>
        </p>
      ) : (
        <CompareBody d={cur.data} />
      )}
    </div>
  );
}

/* ================================================================== sides + baselines */

function clock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "";
  }
}

function Side({ label, s, what }: { label: "A" | "B"; s: CompareSide; what: string }) {
  const pinned = pinnedIds.value.has(s.id);
  return (
    <div class="cmp-side">
      <span class={`cmp-tag cmp-tag-${label.toLowerCase()}`} title={what}>
        {label}
      </span>
      <button
        type="button"
        class="link-btn mono cmp-side-url"
        onClick={() => void loadTrace(s.id, "user")}
        title={`Open ${label} (${what})`}
      >
        {s.method} {s.url}
      </button>
      <span class="mono dim">
        {s.status ?? (s.error ? "ERR" : "")}
        {s.epoch !== undefined ? ` · e${s.epoch}` : ""} · {clock(s.startedAt)}
        {s.cold ? " · cold" : ""}
      </span>
      <span class="mono cmp-side-ms">{fmtMs(s.duration)}</span>
      <button
        type="button"
        class={`cmp-pin ${pinned ? "on" : ""}`}
        aria-pressed={pinned}
        onClick={() => void setPinned(s.id, !pinned)}
        title={
          pinned
            ? "Pinned: kept past ring rotation. Click to release the pin."
            : "Not pinned: it can rotate out. Click to pin it."
        }
      >
        {pinned ? "pinned" : "pin"}
      </button>
    </div>
  );
}

function Baselines({ a, b }: { a: string; b: string }) {
  const entry = baselinesOf(b);
  const list = entry?.list ?? [];
  const picking = pickState.value?.b === b;
  return (
    <nav class="cmp-baselines" aria-label="Baselines for B">
      <span class="t-label dim">Baseline for B</span>
      {entry?.status === "loading" && list.length === 0 && <span class="dim">finding baselines…</span>}
      {list.map((x) => {
        const on = x.id === a;
        return (
          <button
            key={x.kind}
            type="button"
            class={`chip ${on ? "chip-active" : ""}`}
            aria-pressed={on}
            disabled={x.id === b}
            onClick={() => openCompare(x.id, b, { replace: true })}
            title={`${BASELINE_LABELS[x.kind]}: ${x.url}${x.epoch !== undefined ? ` (e${x.epoch})` : ""}, ${clock(x.startedAt)}`}
          >
            {BASELINE_LABELS[x.kind]}
            {x.epoch !== undefined ? ` e${x.epoch}` : ""} <span class="mono">{fmtMs(x.duration)}</span>
          </button>
        );
      })}
      <button
        type="button"
        class={`chip ${picking ? "chip-active" : ""}`}
        aria-pressed={picking}
        onClick={() => (picking ? cancelPick() : startPick(b))}
        title="Open any request in the list to use it as A"
      >
        pick from list <kbd>{formatKey("c c")}</kbd>
      </button>
    </nav>
  );
}

/** Pick mode (`c c`): says what the next click in the list does, and how to back out. */
export function PickBanner() {
  const pick = pickState.value;
  if (!pick) return null;
  return (
    <output class="cmp-pick">
      Pick the baseline: open any request in the list (click, or <kbd>j</kbd>/<kbd>k</kbd> then <kbd>Enter</kbd>
      ). It becomes A and this request stays B.{" "}
      <button type="button" class="link-btn" onClick={cancelPick}>
        Cancel <kbd>Esc</kbd>
      </button>
    </output>
  );
}

function Missing({ missing, b }: { missing: ("a" | "b")[]; b: string }) {
  const which =
    missing.length === 2 ? "Neither request is retained" : `${missing[0] === "a" ? "A" : "B"} is no longer retained`;
  return (
    <div class="cmp-missing">
      <p class="subject-lead">{which}: it rotated out before a compare pinned it.</p>
      {!missing.includes("b") && <p class="subject-lead">Pick another baseline above, or pick one from the list.</p>}
      {missing.includes("b") && (
        <button type="button" class="sbtn" onClick={() => go({ view: "requests" })}>
          Back to the requests
        </button>
      )}
      {!missing.includes("b") && (
        <button type="button" class="sbtn" onClick={() => startPick(b)}>
          Pick from the list
        </button>
      )}
    </div>
  );
}

/* ================================================================== body */

function CompareBody({ d }: { d: CompareResult }) {
  const tone = d.summary.direction === "slower" ? "worse" : d.summary.direction === "faster" ? "better" : "same";
  const pct = fmtDeltaPct(d.a.duration, d.b.duration);
  const counts = countChanges(d.counts);
  return (
    <>
      <header class="cmp-sides">
        <Side label="A" s={d.a} what="baseline" />
        <Side label="B" s={d.b} what="subject" />
        <button
          type="button"
          class="sbtn cmp-swap"
          onClick={() => openCompare(d.b.id, d.a.id)}
          title="Swap A and B (B becomes the baseline)"
        >
          swap
        </button>
      </header>
      {!d.sameRoute && (
        <p class="cmp-note">
          Different routes: spans only match where the code paths overlap, so expect many added and removed rows.
        </p>
      )}
      <section class={`cmp-summary cmp-${tone}`} aria-label="Summary">
        <p class="t-hero cmp-sentence">{d.summary.sentence}</p>
        <p class="cmp-meta">
          <span class={`mono cmp-delta cmp-${tone}`}>
            {fmtMs(d.a.duration)} → {fmtMs(d.b.duration)} ({fmtDelta(d.summary.deltaMs)}
            {pct ? `, ${pct}` : ""})
          </span>
          {counts.map((c) => (
            <span key={c.text} class={`mono cmp-${c.tone}`}>
              {c.text}
            </span>
          ))}
          <span class="dim">
            spans: {d.spans.matched} matched · {d.spans.onlyA} only in A · {d.spans.onlyB} only in B
            {d.spans.truncated ? " (capped)" : ""}
          </span>
        </p>
      </section>
      <Buckets d={d} />
      <Findings d={d} />
      <SpanTree d={d} />
      <Payloads d={d} />
      {compareNotice.value && (
        <p class="cmp-error" role="alert">
          {compareNotice.value}
        </p>
      )}
    </>
  );
}

function Buckets({ d }: { d: CompareResult }) {
  const mode = valueMode.value;
  const rows = bucketView(d.buckets, mode);
  if (rows.length === 0) return null;
  const fmt = (v: number) => (mode === "share" ? `${Math.round(v)}%` : fmtMs(v));
  const fmtD = (v: number) =>
    mode === "share" ? (Math.abs(v) < 0.5 ? "=" : `${v > 0 ? "+" : "−"}${Math.round(Math.abs(v))} pts`) : fmtDelta(v);
  return (
    <section class="cmp-section" aria-labelledby="cmp-buckets">
      <header class="cmp-section-head">
        <h3 id="cmp-buckets" class="section-head">
          Time by bucket
        </h3>
        <fieldset class="cmp-seg">
          <legend class="sr-only">Values</legend>
          {(["abs", "share"] as const).map((m) => (
            <button
              key={m}
              type="button"
              class={`chip ${mode === m ? "chip-active" : ""}`}
              aria-pressed={mode === m}
              onClick={() => {
                valueMode.value = m;
              }}
            >
              {m === "abs" ? "ms" : "share"}
            </button>
          ))}
        </fieldset>
      </header>
      <div class="cmp-scroll">
        <table class="cmp-table cmp-buckets">
          <thead>
            <tr>
              <th scope="col">bucket</th>
              <th scope="col" class="num">
                A
              </th>
              <th scope="col" class="num">
                B
              </th>
              <th scope="col" class="num">
                change
              </th>
              <th scope="col">
                <span class="sr-only">size of the change</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bucket}>
                <th scope="row">
                  <span class="cmp-swatch" style={{ background: `var(--b-${r.bucket})` }} aria-hidden="true" />
                  {r.label}
                </th>
                <td class="num mono">{fmt(r.a)}</td>
                <td class="num mono">{fmt(r.b)}</td>
                <td class={`num mono cmp-${r.tone}`}>{fmtD(r.delta)}</td>
                <td class="cmp-bar-cell">
                  <span class={`cmp-bar cmp-bar-${r.tone}`} style={{ width: `${Math.max(2, r.bar * 100)}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function findingLine(f: FindingSummary): string {
  const loc = f.location ? ` (${f.location.file.split("/").pop()}:${f.location.line})` : "";
  return `${f.title}${loc}`;
}

function Findings({ d }: { d: CompareResult }) {
  const { added, resolved, changed, kept } = d.findings;
  if (!added.length && !resolved.length && !changed.length) {
    return kept > 0 ? (
      <p class="cmp-note dim">
        Findings: the same {kept} in both ({kept === 1 ? "it is" : "they are"} on the request page).
      </p>
    ) : null;
  }
  return (
    <section class="cmp-section" aria-labelledby="cmp-findings">
      <header class="cmp-section-head">
        <h3 id="cmp-findings" class="section-head">
          Findings
        </h3>
        {kept > 0 && <span class="dim">{kept} unchanged</span>}
      </header>
      <ul class="cmp-findings">
        {added.map((f) => (
          <li key={`a${f.fingerprint}`} class="cmp-finding">
            <span class="cmp-glyph cmp-worse" aria-hidden="true">
              +
            </span>
            <span class="cmp-flabel">new in B</span>
            <span class={`cmp-sev cmp-sev-${f.severity}`} aria-hidden="true" />
            <span class="cmp-ftitle">
              {RULE_LABELS[f.rule] ?? f.rule}: {findingLine(f)}
            </span>
            {f.location && (
              <button
                type="button"
                class="link-btn"
                onClick={() => f.location && openSourceAt(f.location.file, f.location.line)}
              >
                source
              </button>
            )}
          </li>
        ))}
        {resolved.map((f) => (
          <li key={`r${f.fingerprint}`} class="cmp-finding">
            <span class="cmp-glyph cmp-better" aria-hidden="true">
              −
            </span>
            <span class="cmp-flabel">resolved</span>
            <span class={`cmp-sev cmp-sev-${f.severity}`} aria-hidden="true" />
            <span class="cmp-ftitle">
              {RULE_LABELS[f.rule] ?? f.rule}: {findingLine(f)}
            </span>
          </li>
        ))}
        {changed.map((f) => (
          <li key={`c${f.fingerprint}`} class="cmp-finding">
            <span class="cmp-glyph" aria-hidden="true">
              ~
            </span>
            <span class="cmp-flabel">changed</span>
            <span />
            <span class="cmp-ftitle">
              {RULE_LABELS[f.rule] ?? f.rule}: {f.title}{" "}
              <span class={`mono ${(f.b ?? 0) > (f.a ?? 0) ? "cmp-worse" : "cmp-better"}`}>
                x{f.a ?? 0} → x{f.b ?? 0}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const MARK_TEXT: Record<RowMark, string> = {
  added: "only B",
  removed: "only A",
  worse: "",
  better: "",
  same: "",
};

function openRowSpan(d: CompareResult, r: CompareRow): void {
  const side = r.b ? "b" : "a";
  const spanId = r[side]?.spanIds[0];
  const traceId = d[side].id;
  go(spanId ? { view: "trace", traceId, spanId } : { view: "trace", traceId });
}

function SpanTree({ d }: { d: CompareResult }) {
  const only = changesOnly.value;
  const showAll = useSignal(false);
  const rows = visibleRows(d.rows, only);
  const shown = showAll.value ? rows : rows.slice(0, ROW_CAP);
  const changed = d.rows.filter((r) => r.status !== "same").length;
  return (
    <section class="cmp-section" aria-labelledby="cmp-spans">
      <header class="cmp-section-head">
        <h3 id="cmp-spans" class="section-head">
          Spans
        </h3>
        <span class="dim">
          {changed} of {d.rows.length} rows changed
        </span>
        <fieldset class="cmp-seg">
          <legend class="sr-only">Rows</legend>
          <button
            type="button"
            class={`chip ${!only ? "chip-active" : ""}`}
            aria-pressed={!only}
            onClick={() => {
              changesOnly.value = false;
            }}
          >
            all
          </button>
          <button
            type="button"
            class={`chip ${only ? "chip-active" : ""}`}
            aria-pressed={only}
            onClick={() => {
              changesOnly.value = true;
            }}
          >
            changes only
          </button>
        </fieldset>
      </header>
      <div class="cmp-scroll">
        <table class="cmp-table cmp-spans">
          <thead>
            <tr>
              <th scope="col">span / shape</th>
              <th scope="col" class="num">
                A
              </th>
              <th scope="col" class="num">
                B
              </th>
              <th scope="col" class="num">
                change
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const mark = rowMark(r);
              const n = countText(r);
              const countChanged = r.a && r.b && r.a.count !== r.b.count;
              return (
                <tr key={r.key} class={`cmp-tr cmp-tr-${mark}`}>
                  <th scope="row" style={{ paddingLeft: `${8 + Math.min(r.depth, 12) * 14}px` }}>
                    {(mark === "added" || mark === "removed") && (
                      <span class={`cmp-glyph cmp-glyph-${mark}`} aria-hidden="true">
                        {mark === "added" ? "+" : "−"}
                      </span>
                    )}
                    <span class="cmp-swatch" style={{ background: `var(--b-${r.bucket})` }} aria-hidden="true" />
                    <button
                      type="button"
                      class="link-btn cmp-span-label"
                      onClick={() => openRowSpan(d, r)}
                      title={`${r.label}\nOpen this span in ${r.b ? "B" : "A"}`}
                    >
                      {r.label}
                    </button>
                    {n && <span class={`mono cmp-count ${countChanged ? "cmp-count-changed" : ""}`}>{n}</span>}
                    {(r.b?.errors ?? 0) > (r.a?.errors ?? 0) && (
                      <span class="cmp-err-chip" title="More errors in B">
                        errors {r.a?.errors ?? 0} → {r.b?.errors ?? 0}
                      </span>
                    )}
                  </th>
                  <td class="num mono">{r.a ? fmtMs(r.a.wallMs) : "—"}</td>
                  <td class="num mono">{r.b ? fmtMs(r.b.wallMs) : "—"}</td>
                  <td class={`num mono cmp-${mark === "added" || mark === "removed" ? "same" : mark}`}>
                    {MARK_TEXT[mark] || fmtDelta(r.deltaMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <button
          type="button"
          class="link-btn"
          onClick={() => {
            showAll.value = true;
          }}
        >
          Show all {rows.length} rows
        </button>
      )}
      {d.rowsTruncated && <p class="cmp-note dim">The diff stopped at 1000 rows; the rest are not compared.</p>}
    </section>
  );
}

function OpsList({ ops, truncated }: { ops: BodyDiff["ops"]; truncated?: boolean }) {
  return (
    <ul class="cmp-ops mono">
      {ops.map((op, i) => (
        <li key={`${op.path}-${i}`} class={`cmp-op cmp-op-${op.op}`}>
          <span class="cmp-glyph" aria-hidden="true">
            {OP_GLYPH[op.op]}
          </span>
          {opText(op)}
        </li>
      ))}
      {truncated && <li class="dim">… more changes not shown (capped at 200)</li>}
    </ul>
  );
}

function HeaderOps({ h }: { h: HeadersDiff }) {
  return (
    <ul class="cmp-ops mono">
      {h.ops.map((op) => (
        <li key={`${op.op}-${op.name}`} class={`cmp-op cmp-op-${op.op}`}>
          <span class="cmp-glyph" aria-hidden="true">
            {op.op === "add" ? "+" : op.op === "remove" ? "−" : "~"}
          </span>
          {op.name}
          {op.op === "add"
            ? `: ${jsonText(op.b, 80)}`
            : op.op === "remove"
              ? `: ${jsonText(op.a, 80)}`
              : `: ${jsonText(op.a, 60)} → ${jsonText(op.b, 60)}`}
        </li>
      ))}
    </ul>
  );
}

function bodySummary(b: BodyDiff): string {
  if (b.mode === "none") return "no body";
  if (b.same) return "same";
  if (b.mode === "json") return `${b.ops.length}${b.truncated ? "+" : ""} change${b.ops.length === 1 ? "" : "s"}`;
  if (b.mode === "mixed") return "different content types";
  return "differs";
}

function BodyPart({ label, b }: { label: string; b: BodyDiff }) {
  return (
    <div class="cmp-part">
      <span class="t-label">
        {label} body: {bodySummary(b)}
        {b.partial ? " (a capture was cut short: the diff may miss changes)" : ""}
      </span>
      {!b.same && b.mode === "json" && <OpsList ops={b.ops} truncated={b.truncated} />}
      {!b.same && b.mode !== "json" && b.mode !== "none" && (
        <span class="dim mono">
          {b.aSize !== undefined ? `A ${b.aSize} B` : ""}
          {b.bSize !== undefined ? ` · B ${b.bSize} B` : ""}
        </span>
      )}
    </div>
  );
}

function Payloads({ d }: { d: CompareResult }) {
  const req = d.request;
  const res = d.response;
  const reqOps = req.headers.ops.length + (req.body.same ? 0 : Math.max(1, req.body.ops.length));
  const statusChanged = res.status.a !== res.status.b;
  const resOps =
    res.headers.ops.length + (res.body.same ? 0 : Math.max(1, res.body.ops.length)) + (statusChanged ? 1 : 0);
  return (
    <section class="cmp-section cmp-payloads" aria-label="Request and response diff">
      <details class="cmp-details" open={statusChanged || (!res.body.same && res.body.mode === "json")}>
        <summary>
          Response diff{" "}
          <span class="dim">({resOps === 0 ? "same" : `${resOps} change${resOps === 1 ? "" : "s"}`})</span>
        </summary>
        {statusChanged && (
          <p class="mono cmp-op">
            status {res.status.a ?? "—"} → {res.status.b ?? "—"}
          </p>
        )}
        <BodyPart label="Response" b={res.body} />
        <div class="cmp-part">
          <span class="t-label">
            Response headers: {res.headers.same ? "same" : `${res.headers.ops.length} changed`}
          </span>
          {!res.headers.same && <HeaderOps h={res.headers} />}
        </div>
      </details>
      <details class="cmp-details">
        <summary>
          Request diff <span class="dim">({reqOps === 0 ? "same" : `${reqOps} change${reqOps === 1 ? "" : "s"}`})</span>
        </summary>
        <BodyPart label="Request" b={req.body} />
        <div class="cmp-part">
          <span class="t-label">
            Request headers: {req.headers.same ? "same" : `${req.headers.ops.length} changed`}
          </span>
          {!req.headers.same && <HeaderOps h={req.headers} />}
        </div>
      </details>
    </section>
  );
}

/* ================================================================== subject-bar entry points */

/**
 * The trace subject bar's Compare button (same as `c`): the default baseline, or picking one from
 * the list when this request has none.
 */
export function CompareButton({ traceId }: { traceId: string }) {
  const entry = baselinesOf(traceId);
  const none = entry?.status === "ready" && entry.list.length === 0;
  return (
    <button
      type="button"
      class="sbtn"
      onClick={() => void compareDefault(traceId)}
      title={
        none
          ? "No earlier request to this route: pick one from the list to compare with (c)"
          : "Compare with the default baseline: previous build, else the previous same-URL request, else the route median (c)"
      }
    >
      {none ? "Compare: pick" : "Compare"} <kbd>c</kbd>
    </button>
  );
}

/** Pin indicator + toggle for the open request (same as `p`), with the last pin failure beside it. */
export function PinToggle({ traceId }: { traceId: string }) {
  const on = pinnedIds.value.has(traceId);
  const notice = compareNotice.value;
  return (
    <>
      <PinButton traceId={traceId} on={on} />
      {notice && (
        <span class="cmp-pin-notice" role="alert">
          {notice}
        </span>
      )}
    </>
  );
}

function PinButton({ traceId, on }: { traceId: string; on: boolean }) {
  return (
    <button
      type="button"
      class={`sbtn cmp-pin-btn ${on ? "on" : ""}`}
      aria-pressed={on}
      onClick={() => togglePin(traceId)}
      title={
        on ? "Pinned: kept past ring rotation. Click to release (p)" : "Pin: keep this request past ring rotation (p)"
      }
    >
      {on ? "Pinned" : "Pin"} <kbd>p</kbd>
    </button>
  );
}
