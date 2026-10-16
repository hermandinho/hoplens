import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import type { Finding, TimeBucket, TraceRecord } from "../api/types";
import { clearHighlight, highlightSpans, selectHop } from "../state/journey";
import { openSourceAt } from "../state/source";
import {
  BUCKETS,
  BUCKET_LABELS,
  RULE_LABELS,
  SMALL_SAMPLE,
  approx,
  fmtMs,
  isHandledError,
  percentiles,
  routeKeyOf,
  statusClass,
  warmDurations,
} from "../state/stats";
import { includeCold, metaState, openBuilder, selectedTrace, tracesState } from "../state/store";
import { selfTimes, toCurl, toFetch, topSpansByBucket } from "../state/traceview";
import { toVitest } from "../state/vitest";

/*
 * Single-request header: what the request was, how long it took and against what baseline, where
 * the time went (budget bar from facts.time) and what is wrong with it (findings strip).
 */

const BUCKET_HINTS: Record<TimeBucket, string> = {
  db: "Database queries",
  cache: "Redis / cache calls",
  ext: "Outgoing fetch / HTTP calls",
  fn: "Self time in your functions, route handler and proxy (span time, not CPU time)",
  framework: "Next.js internals: routing, rendering, response",
  compile: "Dev compile and module loading",
  idle: "Request time that no captured span accounts for",
};

export function TraceHeader() {
  const trace = selectedTrace.value;
  if (!trace) {
    return (
      <section class="rh rh-empty" aria-label="Request summary">
        <span class="dim">No request selected. Pick one from Traffic, or send one.</span>
        <button type="button" class="sbtn" onClick={() => openBuilder()}>
          New request
        </button>
      </section>
    );
  }

  const facts = trace.facts;
  const reqBytes = facts?.reqBytes ?? trace.request.body?.size;
  const resBytes = facts?.resBytes ?? trace.response.body?.size;

  return (
    <section class="rh" aria-label="Request summary">
      <div class="rh-top">
        <span class={`method-tag m-${trace.method}`}>{trace.method}</span>
        <span class="rh-path mono" title={trace.url}>
          {trace.route ?? trace.path}
        </span>
        <span class={`status-code ${statusClass(trace)}`}>{trace.status ?? (trace.done ? "—" : "…")}</span>
        {isHandledError(trace) && trace.error && (
          <span
            class="handled-badge"
            title={`Caught inside the request; the response still went out as ${trace.status}.\n${trace.error.type}: ${trace.error.message}`}
          >
            handled error
          </span>
        )}
        <span class="rh-stats">
          <Stat label="total" value={trace.duration !== undefined ? fmtMs(trace.duration) : "…"} />
          {facts?.ttfb !== undefined && (
            <Stat label="TTFB" value={fmtMs(facts.ttfb)} title="Time to the first response byte" />
          )}
          {(reqBytes !== undefined || resBytes !== undefined) && (
            <Stat
              label="in / out"
              value={`${fmtBytes(reqBytes)} / ${fmtBytes(resBytes)}`}
              title="Request body bytes / response bytes written"
            />
          )}
          <VsRoute trace={trace} />
          {facts?.cold && (
            <span
              class="cold-badge"
              title={`Cold: first request after a rebuild, or compiled ${fmtMs(facts.compileMs)}`}
            >
              cold
            </span>
          )}
        </span>
        <span class="rh-actions">
          <CopyMenu trace={trace} />
          <button
            type="button"
            class="sbtn"
            onClick={() => openBuilder(trace)}
            title="Open the request builder for this route"
          >
            New request
          </button>
        </span>
      </div>
      <BudgetBar trace={trace} />
      <FindingsStrip key={trace.id} trace={trace} />
    </section>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span class="rh-stat" title={title}>
      <span class="rh-stat-k">{label}</span>
      <span class="rh-stat-v mono">{value}</span>
    </span>
  );
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/* ---------------------------------------------------------- vs route p50 */

/** This request against the route's other (warm, unless toggled) requests. */
function VsRoute({ trace }: { trace: TraceRecord }) {
  const cold = includeCold.value;
  const traces = tracesState.value;
  if (trace.duration === undefined) return null;
  const key = routeKeyOf(trace);
  const others = traces.filter((t) => t.id !== trace.id && routeKeyOf(t) === key);
  const p = percentiles(warmDurations(others, cold));
  if (p.n === 0 || p.p50 === undefined) return null;
  const delta = trace.duration - p.p50;
  const small = p.n < SMALL_SAMPLE;
  return (
    <span
      class={`rh-vs ${small ? "pctl-small" : delta > 0 ? "rh-vs-up" : "rh-vs-down"}`}
      title={`Route p50 ${fmtMs(p.p50)} over ${p.n} other ${cold ? "" : "warm "}request${p.n === 1 ? "" : "s"}${small ? " (small sample: rough guide)" : ""}`}
    >
      vs route p50{" "}
      <span class="mono">
        {approx(p.n)}
        {fmtMs(Math.abs(delta))} {delta >= 0 ? "slower" : "faster"}
      </span>
      <span class="pctl-n">n={p.n}</span>
    </span>
  );
}

/* ------------------------------------------------------------ budget bar */

function BudgetBar({ trace }: { trace: TraceRecord }) {
  const facts = trace.facts;
  const top = useMemo(() => topSpansByBucket(trace.spans, selfTimes(trace.spans), 5), [trace.spans]);
  if (!facts) {
    return (
      <div class="budget budget-none dim">
        {trace.done ? "No timing facts for this request." : "The time budget appears when the request finishes."}
      </div>
    );
  }
  const sum = BUCKETS.reduce((s, b) => s + (facts.time[b] ?? 0), 0);
  const denom = Math.max(sum, trace.duration ?? 0, 1e-6);
  const ttfb = facts.ttfb;
  let offset = 0;
  const summary = BUCKETS.filter((b) => (facts.time[b] ?? 0) > 0)
    .map((b) => `${BUCKET_LABELS[b]} ${fmtMs(facts.time[b])}`)
    .join(", ");

  return (
    <div class="budget">
      <span class="sr-only">Time budget: {summary || "no time recorded"}</span>
      <div class="budget-bar">
        {BUCKETS.map((b) => {
          const v = facts.time[b] ?? 0;
          if (v <= 0) return null;
          const pct = (v / denom) * 100;
          const left = offset;
          offset += pct;
          const spans = top[b];
          return (
            <span
              key={b}
              class={`budget-seg b-${b}`}
              style={{ width: `${pct}%` }}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the tooltip
              tabIndex={0}
              aria-label={`${BUCKET_LABELS[b]} ${fmtMs(v)}, ${Math.round(pct)}%`}
            >
              {/* Name + ms only where it fits; a narrower segment shows just the ms, a sliver
                  nothing (the legend below always has both). */}
              {pct >= 9 && (
                <span class="budget-seg-label mono">{pct >= 22 ? `${BUCKET_LABELS[b]} ${fmtMs(v)}` : fmtMs(v)}</span>
              )}
              <span class={`budget-tip ${left + pct / 2 > 60 ? "budget-tip-right" : ""}`} role="tooltip">
                <span class="budget-tip-head">
                  <span class={`legend-swatch b-${b}`} aria-hidden="true" />
                  <b>{BUCKET_LABELS[b]}</b>
                  <span class="mono">
                    {fmtMs(v)} · {pctLabel(pct)}
                  </span>
                </span>
                <span class="budget-tip-hint dim">{BUCKET_HINTS[b]}</span>
                {spans.length > 0 && (
                  <ol class="budget-tip-spans">
                    {spans.map((x) => (
                      <li key={x.span.id}>
                        <button type="button" class="budget-tip-span" onClick={() => selectHop(x.span.id)}>
                          <span class="mono budget-tip-ms">{fmtMs(x.self)}</span>
                          <span class="budget-tip-name" title={x.span.name}>
                            {x.span.name}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </span>
            </span>
          );
        })}
        {ttfb !== undefined && ttfb <= denom && (
          <div class="budget-ttfb" style={{ left: `${(ttfb / denom) * 100}%` }} title={`TTFB ${fmtMs(ttfb)}`}>
            <span
              class={`budget-ttfb-label mono ${ttfb / denom > 0.92 ? "budget-ttfb-label-end" : ttfb / denom < 0.05 ? "budget-ttfb-label-start" : ""}`}
            >
              TTFB
            </span>
          </div>
        )}
      </div>
      <ul class="budget-legend" aria-label="Time per bucket">
        {BUCKETS.map((b) => {
          const v = facts.time[b] ?? 0;
          return (
            <li key={b} class={v > 0 ? "" : "budget-legend-zero"} title={BUCKET_HINTS[b]}>
              <span class={`legend-swatch b-${b}`} aria-hidden="true" />
              <span>{BUCKET_LABELS[b]}</span>
              <span class="mono">{fmtMs(v)}</span>
              <span class="mono dim">{pctLabel((v / denom) * 100)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function pctLabel(p: number): string {
  if (p <= 0) return "0%";
  if (p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

/* -------------------------------------------------------- findings strip */

function FindingsStrip({ trace }: { trace: TraceRecord }) {
  const [open, setOpen] = useState<number | null>(null);
  const findings = trace.findings ?? [];
  if (findings.length === 0) {
    if (!trace.done || !trace.facts) return null;
    return <div class="fstrip fstrip-none dim">No findings for this request.</div>;
  }
  const current = open !== null ? findings[open] : undefined;
  return (
    <div class="fstrip-wrap">
      <ul class="fstrip" aria-label="Findings for this request">
        {findings.map((f, i) => (
          <li key={`${f.fingerprint}-${i}`}>
            <button
              type="button"
              class={`fchip fchip-${f.severity} ${open === i ? "active" : ""}`}
              aria-expanded={open === i}
              onClick={() => {
                if (open === i) {
                  // Closing the chip drops its highlight too.
                  clearHighlight();
                  setOpen(null);
                  return;
                }
                if (f.spanIds.length > 0) highlightSpans(f.spanIds);
                else clearHighlight();
                setOpen(i);
              }}
              title={f.detail ?? f.title}
            >
              <span class={`sev-dot sev-${f.severity}`} aria-hidden="true" />
              <span class="fchip-rule">{RULE_LABELS[f.rule] ?? f.rule}</span>
              <span class="fchip-title">{f.title}</span>
              {f.estSavedMs !== undefined && f.estSavedMs >= 1 && (
                <span class="fchip-save mono">~{fmtMs(f.estSavedMs)}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {current && <FindingDetail finding={current} />}
    </div>
  );
}

function FindingDetail({ finding: f }: { finding: Finding }) {
  return (
    <div class={`fdetail fdetail-${f.severity}`}>
      <div class="fdetail-title">{f.title}</div>
      {f.detail && <p class="fdetail-text">{f.detail}</p>}
      <dl class="fdetail-meta">
        {f.fn && (
          <div>
            <dt class="dim">function</dt>
            <dd class="mono">{f.fn}</dd>
          </div>
        )}
        {f.location && (
          <div>
            <dt class="dim">where</dt>
            <dd>
              <button
                type="button"
                class="src-link mono"
                onClick={() => openSourceAt(f.location!.file, f.location!.line)}
                title="Open in source viewer"
              >
                <span class="src-link-arrow" aria-hidden="true">
                  ↗
                </span>
                {f.location.file}:{f.location.line}
              </button>
            </dd>
          </div>
        )}
        {f.count !== undefined && (
          <div>
            <dt class="dim">count</dt>
            <dd class="mono">×{f.count}</dd>
          </div>
        )}
        {f.estSavedMs !== undefined && (
          <div>
            <dt class="dim">est. saving</dt>
            <dd class="mono">~{fmtMs(f.estSavedMs)}</dd>
          </div>
        )}
        {f.spanIds.length > 0 && (
          <div>
            <dt class="dim">spans</dt>
            <dd>
              <button type="button" class="sbtn" onClick={() => highlightSpans(f.spanIds)}>
                Show {f.spanIds.length} in waterfall
              </button>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------- copy menu */

type CopyKind = "curl" | "curl-secrets" | "fetch" | "vitest" | "link";

const COPY_ITEMS: { kind: CopyKind; label: string }[] = [
  { kind: "curl", label: "Copy as curl" },
  { kind: "fetch", label: "Copy as fetch()" },
  { kind: "vitest", label: "Copy as Vitest test" },
  { kind: "link", label: "Copy trace link" },
  { kind: "curl-secrets", label: "Copy as curl, with secrets" },
];

/** Deep link to this trace in the Hoplens UI (the #trace= hash the store already reads). */
function traceLink(id: string): string {
  if (typeof location === "undefined") return `#trace=${encodeURIComponent(id)}`;
  return `${location.origin}${location.pathname}${location.search}#trace=${encodeURIComponent(id)}`;
}

/** The route's warm p95 over the traces this tab holds (this one included), when there are any. */
function routeP95(trace: TraceRecord): { ms: number; n: number } | undefined {
  const key = routeKeyOf(trace);
  const p = percentiles(
    warmDurations(
      tracesState.value.filter((t) => t.done && routeKeyOf(t) === key),
      false,
    ),
  );
  return p.p95 !== undefined && p.n > 0 ? { ms: p.p95, n: p.n } : undefined;
}

async function copyText(trace: TraceRecord, kind: CopyKind): Promise<string> {
  if (kind === "link") return traceLink(trace.id);
  const req = await api.rawRequest(trace.id);
  const origin = appOrigin();
  if (kind === "fetch") return toFetch(req, origin, true);
  if (kind === "vitest") {
    const c = trace.facts?.counts;
    return toVitest(
      req,
      {
        id: trace.id,
        method: trace.method,
        path: trace.path,
        route: trace.route,
        status: trace.status,
        duration: trace.duration,
        counts: c ? { db: c.db, fetch: c.fetch, cache: c.cache } : undefined,
      },
      { baseUrl: origin, p95: routeP95(trace), capturedAt: new Date(trace.startedAt) },
    );
  }
  return toCurl(req, origin, kind === "curl");
}

function appOrigin(): string {
  const port = metaState.value?.appPort;
  if (typeof location === "undefined") return port ? `http://localhost:${port}` : "http://localhost:3000";
  // Served from the standalone UI port: point at the app instead.
  if (port && location.port !== String(port)) return `${location.protocol}//${location.hostname}:${port}`;
  return location.origin;
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through: insecure context or denied */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("Clipboard unavailable");
}

function CopyMenu({ trace }: { trace: TraceRecord }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 1800);
    return () => clearTimeout(t);
  }, [msg]);

  const copy = async (kind: CopyKind) => {
    setOpen(false);
    try {
      await writeClipboard(await copyText(trace, kind));
      setMsg(
        kind === "curl-secrets"
          ? "Copied (includes secrets)"
          : kind === "vitest"
            ? "Copied test (secrets left out)"
            : kind === "link"
              ? "Link copied"
              : "Copied",
      );
    } catch (err) {
      setMsg(`Copy failed: ${(err as Error).message.slice(0, 60)}`);
    }
  };

  return (
    <div class="copy-menu" ref={ref}>
      <button
        type="button"
        class="sbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="Copy this request to replay it elsewhere"
      >
        Copy ▾
      </button>
      {open && (
        <div class="copy-menu-list" role="menu">
          {COPY_ITEMS.map((it) => (
            <button
              key={it.kind}
              type="button"
              role="menuitem"
              class="copy-menu-item"
              onClick={() => void copy(it.kind)}
            >
              {it.label}
            </button>
          ))}
          <div class="copy-menu-note dim">
            Authorization and cookie headers are redacted (left out of the Vitest test) unless you pick "with secrets".
          </div>
        </div>
      )}
      {msg && (
        <output class="copy-menu-msg mono" aria-live="polite">
          {msg}
        </output>
      )}
    </div>
  );
}
