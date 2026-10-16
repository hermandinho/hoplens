import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import type { TimeBucket, TraceFacts, TraceRecord } from "../api/types";
import { selectHop } from "../state/journey";
import { formatRoute, route } from "../state/router";
import { serverStats } from "../state/serverStats";
import {
  BUCKETS,
  BUCKET_LABELS,
  fmtMs,
  isHandledError,
  percentiles,
  routeKeyOf,
  statusClass,
  warmDurations,
} from "../state/stats";
import { includeCold, metaState, openBuilder, selectedTrace, tracesState } from "../state/store";
import { type SpanSelf, selfTimes, toCurl, toFetch, topSpansByBucket } from "../state/traceview";
import { type Baseline, preHandlerWait, traceBaselines } from "../state/verdict";
import { toVitest } from "../state/vitest";
import { ReplayActions, TraceReplayPanel } from "./ReplayPanel";
import { EditContext } from "./SinceStrip";
import { Verdict } from "./Verdict";
import "../styles/verdict.css";

/*
 * Single-request header, cause first: what the request was and how long it took, its baselines
 * (same URL, route, before the last edit), the verdict (why it was slow and where), then the time
 * budget bar as evidence. Bar segments open their popover on click.
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
        <span class="dim">No request selected. Pick one from the Requests list, or send one.</span>
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
          <ReplayActions trace={trace} />
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
      <Baselines trace={trace} />
      <EditContext trace={trace} />
      <TraceReplayPanel traceId={trace.id} />
      <Verdict trace={trace} />
      <BudgetBar key={trace.id} trace={trace} />
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

/* ------------------------------------------------------------- baselines */

/**
 * This request against its own URL variant (so `?fast=1` is not judged by `?fast=0`), the route as
 * a whole when it has several variants, and the same URL before the last dev rebuild.
 */
function Baselines({ trace }: { trace: TraceRecord }) {
  const cold = includeCold.value;
  const stats = serverStats.value;
  const traces = tracesState.value;
  const list = useMemo(() => traceBaselines(trace, stats, traces, cold), [trace, stats, traces, cold]);
  if (list.length === 0) return null;
  return (
    <div class="rh-baselines" aria-label="Baselines">
      {list.map((b) => (
        <BaselineChip key={b.kind} b={b} cold={cold} />
      ))}
    </div>
  );
}

function BaselineChip({ b, cold }: { b: Baseline; cold: boolean }) {
  const pct = Math.round(b.deltaPct * 100);
  const same = Math.abs(b.deltaMs) < 1 || Math.abs(pct) < 3;
  const sign = b.deltaMs >= 0 ? "+" : "-";
  const delta = b.kind === "edit" ? `${sign}${fmtMs(Math.abs(b.deltaMs))}` : `${sign}${Math.abs(pct)}%`;
  const sample = `${b.n} ${cold ? "" : "warm "}request${b.n === 1 ? "" : "s"}${b.includesSelf ? ", this one included" : ""}`;
  const where = b.source === "server" ? "" : " in this tab";
  const build = b.epoch !== undefined ? ` (build e${b.epoch})` : "";
  return (
    <span
      class={`rh-vs ${b.small ? "pctl-small" : same ? "" : b.deltaMs > 0 ? "rh-vs-up" : "rh-vs-down"}`}
      title={`${b.label} p50 ${fmtMs(b.p50)} over ${sample}${where}${build}${b.small ? ". Small sample: a rough guide" : ""}`}
    >
      vs {b.label}{" "}
      <span class="mono">
        {b.small ? "~" : ""}
        {fmtMs(b.p50)} ({same ? "=" : delta})
      </span>
      <span class="pctl-n">
        n={b.n}
        {b.includesSelf ? " incl. this" : ""}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------ budget bar */

type SegKey = TimeBucket | "wait";

interface Seg {
  key: SegKey;
  ms: number;
  /** The wait segment: how much it took from each bucket (compile, idle, framework). */
  parts?: Partial<Record<TimeBucket, number>>;
}

/** Pre-handler wait shown as its own segment when it is at least this share of the request. */
const WAIT_MIN_SHARE = 0.05;

/**
 * Bar segments: a named "wait" segment for the time before the handler ran (cold compile, proxy,
 * routing), then the buckets. The wait is carved out of compile, then idle, then framework time:
 * that is what the pre-handler stretch is made of, so the bar still sums to the request.
 */
function segmentsOf(facts: TraceFacts, wait: number | undefined, total: number): Seg[] {
  const time = { ...facts.time };
  const out: Seg[] = [];
  if (wait !== undefined && wait >= 5 && total > 0 && wait / total >= WAIT_MIN_SHARE) {
    let left = wait;
    const parts: Partial<Record<TimeBucket, number>> = {};
    for (const b of ["compile", "idle", "framework"] as const) {
      const take = Math.min(left, time[b] ?? 0);
      time[b] = (time[b] ?? 0) - take;
      left -= take;
      if (take > 0) parts[b] = take;
    }
    const carved = wait - left;
    if (carved > 0) out.push({ key: "wait", ms: carved, parts });
  }
  for (const b of BUCKETS) if ((time[b] ?? 0) > 0) out.push({ key: b, ms: time[b] });
  return out;
}

const WAIT_HINT = "Time before your route handler started: dev compile, proxy and routing";

function segLabel(k: SegKey): string {
  return k === "wait" ? "wait" : BUCKET_LABELS[k];
}

function BudgetBar({ trace }: { trace: TraceRecord }) {
  const facts = trace.facts;
  const top = useMemo(() => topSpansByBucket(trace.spans, selfTimes(trace.spans), 5), [trace.spans]);
  const [open, setOpen] = useState<SegKey | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!facts) {
    return (
      <div class="budget budget-none dim">
        {trace.done ? "No timing facts for this request." : "The time budget appears when the request finishes."}
      </div>
    );
  }
  const sum = BUCKETS.reduce((s, b) => s + (facts.time[b] ?? 0), 0);
  const denom = Math.max(sum, trace.duration ?? 0, 1e-6);
  const segs = segmentsOf(facts, preHandlerWait(trace), denom);
  const ttfb = facts.ttfb;
  const summary = segs.map((g) => `${segLabel(g.key)} ${fmtMs(g.ms)}`).join(", ");
  let offset = 0;
  const placed = segs.map((g) => {
    const pct = (g.ms / denom) * 100;
    const left = offset;
    offset += pct;
    return { ...g, pct, left };
  });
  const cur = placed.find((g) => g.key === open);
  const wait = placed.find((g) => g.key === "wait");

  return (
    <div class="budget budget-quiet" ref={ref}>
      <span class="sr-only">Time budget: {summary || "no time recorded"}</span>
      <div class="budget-bar">
        {placed.map((g) => (
          <button
            type="button"
            key={g.key}
            class={`budget-seg ${g.key === "wait" ? "budget-wait" : `b-${g.key}`} ${open === g.key ? "open" : ""}`}
            style={{ width: `${g.pct}%` }}
            aria-haspopup="dialog"
            aria-expanded={open === g.key}
            aria-label={`${segLabel(g.key)} ${fmtMs(g.ms)}, ${Math.round(g.pct)}%`}
            onClick={() => setOpen(open === g.key ? null : g.key)}
          >
            {/* Name + ms only where it fits; a narrower segment shows just the ms, a sliver
                nothing (the legend below always has both). */}
            {g.pct >= 9 && (
              <span class="budget-seg-label mono">
                {g.pct >= 22 ? `${segLabel(g.key)} ${fmtMs(g.ms)}` : fmtMs(g.ms)}
              </span>
            )}
          </button>
        ))}
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
      {cur && (
        <BudgetPopover
          seg={cur.key}
          ms={cur.ms}
          pct={cur.pct}
          center={cur.left + cur.pct / 2}
          spans={cur.key === "wait" ? [] : top[cur.key]}
          onPick={(id) => {
            selectHop(id);
            setOpen(null);
          }}
        />
      )}
      <ul class="budget-legend" aria-label="Time per bucket">
        {wait && (
          <li title={`${WAIT_HINT}${waitParts(wait.parts) ? `. Includes ${waitParts(wait.parts)}` : ""}`}>
            <span class="legend-swatch budget-wait" aria-hidden="true" />
            <span>wait</span>
            <span class="mono">{fmtMs(wait.ms)}</span>
            <span class="mono dim">{pctLabel(wait.pct)}</span>
            {(wait.parts?.compile ?? 0) >= 1 && (
              <span class="dim">incl. {fmtMs(wait.parts?.compile ?? 0)} compile</span>
            )}
          </li>
        )}
        {BUCKETS.map((b) => {
          const v = placed.find((g) => g.key === b)?.ms ?? 0;
          // Nothing drawn that is empty: a bucket with no time has no legend entry.
          if (v <= 0) return null;
          return (
            <li key={b} title={BUCKET_HINTS[b]}>
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

/** Click popover for one bar segment, anchored under the bar near the segment's middle. */
function BudgetPopover({
  seg,
  ms,
  pct,
  center,
  spans,
  onPick,
}: {
  seg: SegKey;
  ms: number;
  pct: number;
  center: number;
  spans: SpanSelf[];
  onPick: (id: string) => void;
}) {
  const right = center > 60;
  return (
    <section
      class={`budget-pop ${right ? "budget-pop-right" : ""}`}
      style={right ? { right: `${Math.max(0, 100 - center - 10)}%` } : { left: `${Math.max(0, center - 10)}%` }}
      aria-label={`${segLabel(seg)} details`}
    >
      <span class="budget-tip-head">
        <span class={`legend-swatch ${seg === "wait" ? "budget-wait" : `b-${seg}`}`} aria-hidden="true" />
        <b>{segLabel(seg)}</b>
        <span class="mono">
          {fmtMs(ms)} · {pctLabel(pct)}
        </span>
      </span>
      <span class="budget-tip-hint dim">{seg === "wait" ? WAIT_HINT : BUCKET_HINTS[seg]}</span>
      {spans.length > 0 && (
        <ol class="budget-tip-spans">
          {spans.map((x) => (
            <li key={x.span.id}>
              <button type="button" class="budget-tip-span" onClick={() => onPick(x.span.id)}>
                <span class="mono budget-tip-ms">{fmtMs(x.self)}</span>
                <span class="budget-tip-name" title={x.span.name}>
                  {x.span.name}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** "compile 870ms, idle 12ms": what the wait segment was carved from. */
function waitParts(parts: Partial<Record<TimeBucket, number>> | undefined): string {
  return Object.entries(parts ?? {})
    .filter(([, v]) => (v ?? 0) >= 1)
    .map(([b, v]) => `${BUCKET_LABELS[b as TimeBucket]} ${fmtMs(v ?? 0)}`)
    .join(", ");
}

function pctLabel(p: number): string {
  if (p <= 0) return "0%";
  if (p < 1) return "<1%";
  return `${Math.round(p)}%`;
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

/**
 * Deep link to this trace in the Hoplens UI, in the router's canonical form (`#/r/<id>`), keeping
 * the selected span and the since scope when this trace is the current route.
 */
function traceLink(id: string): string {
  const r = route.peek();
  const hash = formatRoute(r.view === "trace" && r.traceId === id ? r : { view: "trace", traceId: id });
  if (typeof location === "undefined") return hash;
  return `${location.origin}${location.pathname}${location.search}${hash}`;
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
