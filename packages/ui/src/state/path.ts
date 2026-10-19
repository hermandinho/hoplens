import { batch, signal } from "@preact/signals";
import { HoplensApiError, api, tapLive } from "../api/client";
import type {
  Meta,
  PathDecision,
  PathDecisionKind,
  PathErrorBody,
  PathExit,
  PathFn,
  PathLoop,
  PathMeta,
  PathPayload,
  PathPayloadAnalysis,
  PathQuality,
  PathTraceStamp,
  PathWhy,
} from "../api/types";
import { pathMode } from "./canvas";
import { route } from "./router";
import { followLive, loadTrace, metaState, selectedTraceId } from "./store";

/*
 * Request path, Path mode of the Journey pane (plan P3): the trail of one replayed request, one lane
 * per function / handler hop with a chip per decision it reached. Pure helpers (chip text, states,
 * error copy) plus the capture's signals. Truth is decided server-side (core path/truth.ts): every
 * taken / not-taken / unknown here is read from the payload, never derived or upgraded.
 * Tested by packages/ui/test/path.test.ts.
 */

/* ------------------------------------------------------------------ copy */

const WHY: Record<PathWhy, string> = {
  "no-blocks": "V8 kept only a function-level count here (no block ranges)",
  contaminated: "other work ran during the capture, so no count here can be trusted",
  "join-mismatch": "the coverage function does not line up with this source function",
  "join-ambiguous": "more than one source function could be this hop",
  "no-location": "the hop has no source location",
  "source-unreadable": "the source file could not be read",
  "too-large": "too large to map (payload caps)",
  "source-moved": "the file changed after the app loaded it: restart and trace again",
  compiled: "the app runs compiled output for this file (TypeScript mapping comes later)",
  "after-throw": "an exception was thrown before this point, so counts after it are not reliable",
  "arms-inconsistent": "the branch counts do not add up, so no side is claimed",
  "no-analyzer": "no control-flow analyzer was loaded (TypeScript missing)",
  "no-function": "no source function matched the coverage range",
  "no-counter": "V8 keeps no counter for this side",
  suspended: "an await or generator was still pending when the counts were read",
};

/** Why a count is UNKNOWN, as a sentence fragment. */
export function whyText(why: PathWhy | string | undefined): string {
  return (why && WHY[why as PathWhy]) || `unknown (${why ?? "no reason given"})`;
}

/** `if !user`, `switch (order.status)`, `user.vip ?`, `rows[0] ??`, `try` (mirrors core decisionText). */
export function decisionText(kind: PathDecisionKind, label: string): string {
  switch (kind) {
    case "if":
      return `if ${label}`;
    case "switch":
      return `switch (${label})`;
    case "ternary":
      return `${label} ?`;
    case "try":
      return "try";
    default:
      return label;
  }
}

export const QUALITY: Record<PathQuality, { label: string; title: string }> = {
  exact: { label: "EXACT", title: "The app ran only this request during the capture: every count is this request's" },
  partial: {
    label: "PARTIAL",
    title: "Some functions could not be mapped or checked: their counts are UNKNOWN, the rest are exact",
  },
  contaminated: {
    label: "CONTAMINATED",
    title: "Other work ran during the capture: every decision is UNKNOWN (see the warnings)",
  },
};

/* ------------------------------------------------------------------ chips */

export type ChipTone = "taken" | "split" | "unknown" | "not";

export interface PathChip {
  id: string;
  kind: "decision" | "loop" | "exit" | "fn";
  text: string;
  /** Hover / focus text: the full label, counts and any UNKNOWN reason. */
  title: string;
  tone: ChipTone;
  line?: number;
  /** The request's exit (the verdict's). */
  exit?: boolean;
}

/** One decision's chip, from the server's verdict and summary. */
export function decisionChip(d: PathDecision): PathChip {
  const head = decisionText(d.kind, d.label);
  const base = { id: d.id, kind: "decision" as const, line: d.line };
  const counts = d.arms.map((a) => `${a.label} ${a.count ?? "?"}`).join(", ");
  const reach = `reached ${d.reach ?? "?"}x`;
  switch (d.verdict) {
    case "one":
      return {
        ...base,
        text: `${head} -> ${d.summary}`,
        title: `L${d.line} ${head}: ${reach}; ${counts}`,
        tone: "taken",
      };
    case "split-loop":
    case "split-calls":
      return {
        ...base,
        text: `${head}: ${d.summary}`,
        title: `L${d.line} ${head}: ${d.verdict === "split-loop" ? "both sides, inside a loop" : "both sides, across calls"}; ${reach}; ${counts}`,
        tone: "split",
      };
    case "unreached":
      return { ...base, text: head, title: `L${d.line} ${head}: not reached`, tone: "not" };
    default: {
      const why = d.why ?? d.arms.find((a) => a.why)?.why;
      return {
        ...base,
        text: `${head}: ${d.summary}`,
        title: `L${d.line} ${head}: UNKNOWN, ${whyText(why)}`,
        tone: "unknown",
      };
    }
  }
}

/** `for (const r of rows) x9600`; passes 0 or never entered: not reached. */
export function loopChip(l: PathLoop, i: number): PathChip {
  const base = { id: `loop#${i}`, kind: "loop" as const, line: l.line };
  if (l.passes === null || l.entries === null)
    return {
      ...base,
      text: `${l.label} x?`,
      title: `L${l.line} ${l.label}: UNKNOWN, ${whyText(l.why)}`,
      tone: "unknown",
    };
  if (l.entries === 0) return { ...base, text: l.label, title: `L${l.line} ${l.label}: not reached`, tone: "not" };
  const per = l.entries > 1 ? `, entered ${l.entries}x` : "";
  return {
    ...base,
    text: `${l.label} x${l.passes}`,
    title: `L${l.line} ${l.label}: ${l.passes} pass${l.passes === 1 ? "" : "es"}${per}`,
    tone: "taken",
  };
}

const EXIT_WORD: Record<PathExit["kind"], string> = {
  return: "return",
  throw: "threw",
  exception: "threw",
  end: "end",
};

/** `return @L21`, `threw @L19`, `end @L25`; count 0: not reached; null: UNKNOWN. */
export function exitChip(e: PathExit, i: number, isRequestExit = false): PathChip {
  const at = e.line === null ? " (line unknown)" : ` @L${e.line}`;
  const word = EXIT_WORD[e.kind];
  const base = { id: `exit#${i}`, kind: "exit" as const, line: e.line ?? undefined };
  const what = e.kind === "exception" ? "an exception passed through here" : `${word}${at}`;
  if (e.count === null)
    return { ...base, text: `${word}${at}`, title: `${what}: UNKNOWN, ${whyText(e.why)}`, tone: "unknown" };
  if (e.count === 0) return { ...base, text: `${word}${at}`, title: `${what}: not reached`, tone: "not" };
  const via = e.via ? ` via ${e.via.label} -> ${e.via.arm}` : "";
  return {
    ...base,
    text: `${word}${at}${e.count > 1 ? ` x${e.count}` : ""}${isRequestExit ? " exit" : ""}`,
    title: `${what}${via}: ${e.count}x${isRequestExit ? " (the request's exit)" : ""}`,
    tone: "taken",
    exit: isRequestExit || undefined,
  };
}

/* ------------------------------------------------------------------ trail */

export interface TrailRow {
  /** The row's first lane's index in payload.lanes. */
  key: string;
  name: string;
  kind: "handler" | "function";
  depth: number;
  file?: string;
  line?: number;
  fnKey?: string;
  /** Lanes folded into this row (consecutive hops of one function at one depth). */
  hops: number;
  /** H: hops of this function in the trace. */
  calls: number;
  /** V8's call count, when it differs from the hops (blended counts are totals over them). */
  coverageCalls?: number;
  blended: boolean;
  threw: boolean;
  /** The function's chips were already shown on an earlier row (same function, another caller). */
  seeRow?: string;
  /** Reached decisions, loops and exits in source order. */
  chips: PathChip[];
  /** Dimmed under '+N not reached'. */
  notReached: PathChip[];
  /** The whole function is UNKNOWN. */
  unknown?: string;
  /** A CFG cap folded the rest of the function: decisions past it are not mapped. */
  truncated?: boolean;
  /** The function's analysis warnings (e.g. a suspended deficit). */
  fnWarnings?: string[];
}

export interface TrailModel {
  rows: TrailRow[];
  functions: number;
  /** Decisions the server says were reached (verdict one / split-loop / split-calls). */
  decisions: number;
  /** Loops with a known entry count > 0 (passes known or not). */
  loops: number;
  /** Decisions with verdict UNKNOWN: neither reached nor not. */
  unknownDecisions: number;
  /** Loops whose entry count is UNKNOWN. */
  unknownLoops: number;
  /** Functions UNKNOWN as a whole (no decisions to count). */
  unknownFns: number;
}

const REACHED = new Set<PathDecision["verdict"]>(["one", "split-loop", "split-calls"]);

function fnChips(
  fn: PathFn | undefined,
  exit: PathPayloadAnalysis["exit"],
): { chips: PathChip[]; notReached: PathChip[]; unknown?: string; truncated?: boolean; warnings?: string[] } {
  const a = fn?.analysis;
  if (!fn) return { chips: [], notReached: [], unknown: "this hop was not joined to a coverage function" };
  if (!a)
    return {
      chips: [],
      notReached: [],
      unknown: fn.truth.t === "unknown" ? whyText(fn.truth.why) : "not analyzed yet",
    };
  if (a.status === "unknown") return { chips: [], notReached: [], unknown: whyText(a.why) };
  const all: PathChip[] = [
    ...a.decisions.map(decisionChip),
    ...a.loops.map(loopChip),
    ...a.exits.map((e, i) =>
      exitChip(e, i, !!exit && exit.fnKey === fn.key && exit.kind === e.kind && exit.line === e.line),
    ),
  ];
  all.sort((x, y) => (x.line ?? Number.MAX_SAFE_INTEGER) - (y.line ?? Number.MAX_SAFE_INTEGER));
  const out: ReturnType<typeof fnChips> = {
    chips: all.filter((c) => c.tone !== "not"),
    notReached: all.filter((c) => c.tone === "not"),
  };
  if (a.truncated) out.truncated = true;
  if (a.warnings?.length) out.warnings = a.warnings;
  return out;
}

/** The trail, from the payload's lanes (span order) and per-function analysis. */
export function trailModel(p: PathPayload): TrailModel {
  const rows: TrailRow[] = [];
  const firstRow = new Map<string, string>();
  const exit = p.analysis?.exit;
  let decisions = 0;
  let loops = 0;
  let unknownDecisions = 0;
  let unknownLoops = 0;
  let unknownFns = 0;
  for (let i = 0; i < p.lanes.length; i++) {
    const l = p.lanes[i]!;
    const prev = rows[rows.length - 1];
    if (prev && l.fnKey && prev.fnKey === l.fnKey && prev.depth === l.depth) {
      prev.hops++;
      prev.threw ||= !!l.threw;
      continue;
    }
    const fn = l.fnKey ? p.functions[l.fnKey] : undefined;
    const key = String(i);
    const seen = l.fnKey ? firstRow.get(l.fnKey) : undefined;
    const row: TrailRow = {
      key,
      name: l.name,
      kind: l.kind,
      depth: l.depth,
      file: l.file ?? fn?.file,
      line: l.line ?? fn?.line,
      fnKey: l.fnKey,
      hops: 1,
      calls: l.calls,
      blended: false,
      threw: !!l.threw,
      chips: [],
      notReached: [],
    };
    // V8's call count K is this request's only when the function is known: on an UNKNOWN function
    // (CONTAMINATED above all) K mixes in other work, so no 'K calls: totals' is claimed.
    const known = fn?.analysis?.status === "ok" && fn.truth.t !== "unknown";
    if (known) {
      row.blended = !!fn.analysis!.blended;
      const cov = fn.calls.coverage;
      if (cov !== null && cov !== l.calls) row.coverageCalls = cov;
    }
    if (seen) row.seeRow = seen;
    else {
      const c = fnChips(fn, exit);
      row.chips = c.chips;
      row.notReached = c.notReached;
      if (c.unknown) row.unknown = c.unknown;
      if (c.truncated) row.truncated = true;
      if (c.warnings) row.fnWarnings = c.warnings;
      if (l.fnKey) {
        firstRow.set(l.fnKey, key);
        if (c.unknown) unknownFns++;
      }
      if (!c.unknown && fn?.analysis) {
        for (const d of fn.analysis.decisions) {
          if (REACHED.has(d.verdict)) decisions++;
          else if (d.verdict === "unknown") unknownDecisions++;
        }
        for (const lp of fn.analysis.loops) {
          if (lp.entries === null) unknownLoops++;
          else if (lp.entries > 0) loops++;
        }
      }
    }
    rows.push(row);
  }
  return { rows, functions: firstRow.size, decisions, loops, unknownDecisions, unknownLoops, unknownFns };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** `3 functions . 2 decisions reached . 1 loop run . UNKNOWN: 1 decision`; nothing UNKNOWN is counted as known. */
export function trailSummary(m: Omit<TrailModel, "rows">): string {
  const parts = [plural(m.functions, "function")];
  const allUnknown = m.functions > 0 && m.unknownFns === m.functions;
  if (allUnknown) parts.push("decisions: UNKNOWN (every function is UNKNOWN)");
  else {
    parts.push(`${plural(m.decisions, "decision")} reached`);
    if (m.loops) parts.push(`${plural(m.loops, "loop")} run`);
  }
  const unknown: string[] = [];
  if (m.unknownDecisions) unknown.push(plural(m.unknownDecisions, "decision"));
  if (m.unknownLoops) unknown.push(plural(m.unknownLoops, "loop"));
  if (m.unknownFns && !allUnknown) unknown.push(plural(m.unknownFns, "function"));
  if (unknown.length) parts.push(`UNKNOWN: ${unknown.join(", ")}`);
  return parts.join(" . ");
}

/** The verdict line, from the server's text. */
export function verdictModel(p: PathPayload): {
  text: string;
  tone: "exit" | "threw" | "unknown";
  at?: { file: string; line: number };
} {
  const a = p.analysis;
  if (!a) return { text: "Exit: UNKNOWN (not analyzed)", tone: "unknown" };
  const e = a.exit;
  const fn = e ? p.functions[e.fnKey] : undefined;
  const at = fn && e && e.line !== null ? { file: fn.file, line: e.line } : undefined;
  // No exit object: either 'Exit: UNKNOWN (...)' or a known multi-exit list ('Exited 2 ways in ...').
  const tone = e
    ? e.kind === "throw" || e.kind === "exception"
      ? "threw"
      : "exit"
    : /^Exit: UNKNOWN\b/.test(a.text)
      ? "unknown"
      : "exit";
  return at ? { text: a.text, tone, at } : { text: a.text, tone };
}

/* ------------------------------------------------------------------ states */

export interface OffView {
  title: string;
  body: string;
  /** Shell line to copy (sets, or for source env unsets, the env var). */
  command?: string;
  /** The line above the command, when it needs one. */
  commandNote?: string;
}

/** `$env:HOPLENS_PATH = "1"` on a Windows app root, `export HOPLENS_PATH=1` elsewhere. */
export function envCommand(root: string | undefined): string {
  return root && /^[a-z]:[\\/]/i.test(root) ? `$env:HOPLENS_PATH = "1"` : "export HOPLENS_PATH=1";
}

/** `Remove-Item Env:HOPLENS_PATH` on a Windows app root, `unset HOPLENS_PATH` elsewhere. */
export function unsetEnvCommand(root: string | undefined): string {
  return root && /^[a-z]:[\\/]/i.test(root) ? "Remove-Item Env:HOPLENS_PATH" : "unset HOPLENS_PATH";
}

/** Why Path mode can't trace here, or null when the request path is on. */
export function offView(meta: Pick<Meta, "path" | "framework" | "root"> | null, isNext: boolean): OffView | null {
  if (isNext)
    return {
      title: "Request path: Express only for now",
      body: "Tracing a request's decisions needs V8 block coverage started before the app loads. Hoplens does that for Express apps; Next.js support comes later.",
    };
  const p = meta?.path;
  if (!p)
    return {
      title: "Request path: not in this Hoplens core",
      body: "This core does not report the request path. Update @hoplens/core (and the adapter) to use it.",
    };
  switch (p.state) {
    case "on":
      return null;
    case "disabled-c8":
      return {
        title: "Request path: disabled (c8 / NODE_V8_COVERAGE is active)",
        body: `${p.reason ?? "NODE_V8_COVERAGE is set"}. Hoplens does not start its own coverage while another tool collects it. Unset NODE_V8_COVERAGE and restart to use it.`,
      };
    case "error":
      return {
        title: "Request path: stopped working",
        body: `${p.reason ?? "Coverage failed"}. Restart the app to try again.`,
      };
    default:
      if (p.source === "env")
        return {
          title: "Request path is off (set by HOPLENS_PATH)",
          body: `${p.reason ? `${capital(p.reason)}. ` : ""}The env var always wins over the switch here. It comes from the dev server's shell or an inline HOPLENS_PATH=... in its dev script (hoplens doctor says which): unset it to use the switch, or set it to 1, then restart the dev server.`,
          command: unsetEnvCommand(meta?.root),
          commandNote: "Unset it in the dev server's shell (if the dev script sets it, edit the script instead):",
        };
      if (p.source === "flag")
        return {
          title: "Request path is enabled but did not start",
          body: `${p.reason ? `${capital(p.reason)}. ` : ""}Coverage has to start before the app loads, from the register hook.`,
        };
      if (p.source === "default" && p.pending === "on")
        return {
          title: "Request path: on at next start",
          body: "Enabled here. It is read at boot, so block coverage starts with the next start of the dev server and stays on while it runs (CPU-heavy code runs slower).",
        };
      if (p.source === "default")
        return {
          title: "Request path is off",
          body: "It is opt-in and read at boot: enable it here (it sticks across restarts), or set HOPLENS_PATH=1 in the dev server's environment. Coverage stays on while it runs, so CPU-heavy code runs slower.",
          command: envCommand(meta?.root),
        };
      return {
        title: "Request path is off",
        body: `${p.reason ? `${capital(p.reason)}. ` : ""}It is opt-in and read at boot: set HOPLENS_PATH=1, then restart the dev server. Coverage stays on while it runs, so CPU-heavy code runs slower.`,
        command: envCommand(meta?.root),
      };
  }
}

/* ------------------------------------------------------------------ switch */

/** The Enable button's cost note. */
export const PATH_COST_NOTE = "block coverage from start; CPU-heavy code runs slower";
/** After a toggle: the flag is read at the next start. */
export const PATH_RESTART_NOTE = "Restart your dev server to apply (saving a file restarts node --watch)";

/**
 * The sticky switch's control for this boot, or null where there is none (Next, an older core):
 * enable (off by default), pending-on (enabled, not applied yet), disable (on via the flag),
 * pending-off (disabled, not applied yet), env (HOPLENS_PATH decides: no toggle).
 */
export type PathSwitch =
  | { kind: "enable" }
  | { kind: "pending-on" }
  | { kind: "disable" }
  | { kind: "pending-off" }
  | { kind: "env" };

export function pathSwitch(meta: Pick<Meta, "path"> | null, isNext: boolean): PathSwitch | null {
  const p = meta?.path;
  if (isNext || !p?.source) return null;
  if (p.source === "env") return { kind: "env" };
  if (p.source === "flag") return { kind: p.pending === "off" ? "pending-off" : "disable" };
  return { kind: p.pending === "on" ? "pending-on" : "enable" };
}

/** The footer line when HOPLENS_PATH decides, worded like the banner and doctor when it is on. */
export function envFootText(state: PathMeta["state"] | undefined): string {
  return state === "on" ? "Request path: on (set by HOPLENS_PATH)" : "Request path: set by HOPLENS_PATH";
}

/** A switch call in flight, and the last one's failure (a sentence). */
export const pathSwitchJob = signal<{ busy: boolean; error?: string }>({ busy: false });

/** The sentence for a failed switch call. Exported for tests. */
export function switchErrorText(err: unknown): string {
  if (err instanceof HoplensApiError) {
    try {
      const body = JSON.parse(err.body) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      /* not JSON */
    }
    return err.status === 404
      ? "This Hoplens core has no request path switch. Update @hoplens/core and @hoplens/express."
      : `The switch failed (HTTP ${err.status})`;
  }
  return `The switch failed: ${(err as Error)?.message ?? "network error"}`;
}

/** Flip the sticky switch (POST), then show the answer's meta.path (its `pending`) right away. */
export async function setPathEnabled(on: boolean): Promise<boolean> {
  if (pathSwitchJob.peek().busy) return false;
  pathSwitchJob.value = { busy: true };
  try {
    const res = await api.pathSwitch(on);
    const meta = metaState.peek();
    batch(() => {
      if (meta) metaState.value = { ...meta, path: res.path as PathMeta };
      pathSwitchJob.value = { busy: false };
    });
    return true;
  } catch (err) {
    pathSwitchJob.value = { busy: false, error: switchErrorText(err) };
    return false;
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Why this trace can't be traced for its path (non-GET/HEAD), or undefined. */
export function methodBlock(method: string): string | undefined {
  const m = (method || "GET").toUpperCase();
  return m === "GET" || m === "HEAD"
    ? undefined
    : `Only GET and HEAD can be traced for their path: replaying a ${m} would run its side effects again`;
}

/** Trace path would run now for this trace: the path is on, GET/HEAD, not a path trace, no capture running. */
export function canTracePath(
  trace: { method: string; pathTrace?: PathTraceStamp },
  meta: Pick<Meta, "path" | "framework" | "root"> | null,
  isNext: boolean,
): boolean {
  return !trace.pathTrace && !offView(meta, isNext) && !methodBlock(trace.method) && !pathJob.peek();
}

export interface PathErrorView {
  code: string;
  title: string;
  detail?: string;
  /** Requests still in flight (not-quiet). */
  list?: string[];
  retry: boolean;
  /** Open another trace (superseded: the kept attempt; evicted: the source). */
  link?: { label: string; traceId: string };
}

/** The copy for a failed POST / GET, by stable error code. */
export function pathErrorView(status: number, body: Partial<PathErrorBody> | undefined): PathErrorView {
  const code = body?.code ?? "";
  const error = body?.error;
  switch (code) {
    case "method":
      return { code, title: "Only GET and HEAD can be traced", detail: error, retry: false };
    case "not-quiet": {
      const n = body?.inflight ?? 0;
      const reason = body?.reason ?? (n ? `${n} request${n === 1 ? "" : "s"} in flight` : "the app is busy");
      return {
        code,
        title: `The app is busy: ${reason}. Nothing was sent.`,
        detail: "Path capture waits for the app to be idle, so other work can't mix into the counts.",
        list: body?.requests?.length ? body.requests : undefined,
        retry: true,
      };
    }
    case "busy":
      return { code, title: "Another path capture is running", detail: "Retry when it finishes.", retry: true };
    case "path-off":
      return {
        code,
        title: "The request path is off",
        detail: `${error ?? ""} Turn it on (Enable request path, or HOPLENS_PATH=1) and restart the app.`.trim(),
        retry: false,
      };
    case "replay-failed": {
      const timedOut = /time|abort/i.test(error ?? "");
      return {
        code,
        title: timedOut
          ? "The replay hit its 30s time limit"
          : `The replay failed${body?.status ? ` (${body.status})` : ""}`,
        detail: timedOut ? "The request did not finish (response and trace) within 30s." : error,
        retry: true,
      };
    }
    case "take-failed":
      return { code, title: "Reading the coverage counts failed", detail: error, retry: true };
    case "not-found":
      return { code, title: "This trace is gone", detail: error ?? "It rotated out of the buffer.", retry: false };
    case "superseded":
      return {
        code,
        title: "This replay was discarded for the automatic retry",
        detail: "Other work ran during it; the retry's trace holds the path.",
        retry: false,
        link: body?.traceId ? { label: "open the retry", traceId: body.traceId } : undefined,
      };
    case "evicted":
      return {
        code,
        title: "This path was dropped",
        detail: "Only the last 20 paths are kept. Trace path the source request again.",
        retry: false,
        link: body?.replayOf ? { label: "open the source request", traceId: body.replayOf } : undefined,
      };
    case "no-path":
      return { code, title: "No request path for this trace", detail: error, retry: false };
    default:
      if (status === 404)
        return {
          code: "no-api",
          title: "This Hoplens core has no request path API",
          detail: "Update @hoplens/core to use Trace path.",
          retry: false,
        };
      return { code: code || "error", title: "Trace path failed", detail: error ?? `HTTP ${status}`, retry: true };
  }
}

/** Parse a failed call into the error view (network errors included). */
export function errorViewOf(err: unknown): PathErrorView {
  if (err instanceof HoplensApiError) {
    let body: Partial<PathErrorBody> | undefined;
    try {
      body = JSON.parse(err.body) as Partial<PathErrorBody>;
    } catch {
      body = undefined;
    }
    return pathErrorView(err.status, body);
  }
  return { code: "network", title: "Trace path failed", detail: (err as Error)?.message, retry: true };
}

/** The stamp of a path trace: on the record, its list summary, or a payload we hold. */
export function stampOf(
  trace: { id: string; pathTrace?: PathTraceStamp } | null | undefined,
  summary?: { pathTrace?: PathTraceStamp },
  payload?: PathPayload,
): PathTraceStamp | undefined {
  return (
    trace?.pathTrace ??
    summary?.pathTrace ??
    (payload ? { quality: payload.quality, replayOf: payload.replayOf } : undefined)
  );
}

/* ------------------------------------------------------------------ capture */

export type CapturePhase = "quiet" | "replaying" | "settling" | "mapping";

export const PHASES: readonly CapturePhase[] = ["quiet", "replaying", "settling", "mapping"];

export const PHASE_TEXT: Record<CapturePhase, string> = {
  quiet: "waiting for the app to be idle",
  replaying: "replaying the request",
  settling: "letting late work settle",
  mapping: "mapping the counts to decisions",
};

/** The running capture (one at a time) and the last failure, per source trace. */
export const pathJob = signal<{ sourceId: string; phase: CapturePhase } | null>(null);
export const pathFailure = signal<{ sourceId: string; view: PathErrorView } | null>(null);

/** Payloads by path-trace id (the POST answer, or a GET). */
export const pathPayloads = signal<ReadonlyMap<string, PathPayload>>(new Map());
export const pathLoad = signal<ReadonlyMap<string, "loading" | PathErrorView>>(new Map());

function setIn<V>(m: ReadonlyMap<string, V>, k: string, v: V | undefined): Map<string, V> {
  const next = new Map(m);
  if (v === undefined) next.delete(k);
  else next.set(k, v);
  // Bounded like the server's LRU.
  while (next.size > 40) next.delete(next.keys().next().value as string);
  return next;
}

/** Fetch a path trace's payload once (GET). */
export async function loadPath(traceId: string): Promise<void> {
  if (pathPayloads.peek().has(traceId) || pathLoad.peek().get(traceId) === "loading") return;
  pathLoad.value = setIn(pathLoad.peek(), traceId, "loading");
  try {
    const p = await api.path(traceId);
    batch(() => {
      pathPayloads.value = setIn(pathPayloads.peek(), traceId, p);
      pathLoad.value = setIn(pathLoad.peek(), traceId, undefined);
    });
  } catch (err) {
    pathLoad.value = setIn(pathLoad.peek(), traceId, errorViewOf(err));
  }
}

/** Forget a failed GET so it can be tried again. */
export function retryLoadPath(traceId: string): void {
  pathLoad.value = setIn(pathLoad.peek(), traceId, undefined);
  void loadPath(traceId);
}

/**
 * Trace path: replay `source` once, alone (POST). The phases follow the live stream: the replay's
 * `start` (replaying), its `done` (settling), then mapping until the answer. Resolves to the new
 * trace id; a failure lands in `pathFailure`.
 */
export async function tracePath(source: { id: string; method: string; url: string }): Promise<string | undefined> {
  if (pathJob.peek()) return undefined;
  const blocked = methodBlock(source.method);
  if (blocked) {
    pathFailure.value = { sourceId: source.id, view: pathErrorView(400, { code: "method", error: blocked }) };
    return undefined;
  }
  batch(() => {
    pathFailure.value = null;
    pathJob.value = { sourceId: source.id, phase: "quiet" };
  });
  const phase = (p: CapturePhase) => {
    const j = pathJob.peek();
    if (j?.sourceId === source.id && PHASES.indexOf(p) > PHASES.indexOf(j.phase)) pathJob.value = { ...j, phase: p };
  };
  let replayId: string | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const untap = tapLive((ev) => {
    if (
      ev.type === "start" &&
      ev.trace.id !== source.id &&
      ev.trace.method === source.method &&
      ev.trace.url === source.url
    ) {
      replayId ??= ev.trace.id;
      phase("replaying");
    } else if (ev.type === "done" && ev.trace.id === replayId) {
      phase("settling");
      settle = setTimeout(() => phase("mapping"), 300);
    }
  });
  try {
    const res = await api.tracePath(source.id);
    pathPayloads.value = setIn(pathPayloads.peek(), res.traceId, res.path);
    return res.traceId;
  } catch (err) {
    pathFailure.value = { sourceId: source.id, view: errorViewOf(err) };
    return undefined;
  } finally {
    untap();
    if (settle) clearTimeout(settle);
    pathJob.value = null;
  }
}

/** The path trace whose trail should take focus when it mounts (after Trace path, or x). */
export const pathFocus = signal<string | null>(null);
/** Polite status text for the path pane's live region. */
export const pathAnnounce = signal("");
/** A capture that finished while the user was elsewhere: offered on the source, not opened. */
export const pathReady = signal<{ sourceId: string; traceId: string } | null>(null);

/**
 * Trace path for `trace`, then open the new trace (in Path mode). Follow goes off first, so the
 * replay's own `done` (and traffic around it) cannot move the selection mid-capture; the new trace
 * opens only when the user is still on the source, else it is left as a 'path ready' note there.
 */
export async function runTracePath(trace: { id: string; method: string; url: string }): Promise<void> {
  batch(() => {
    pathMode.value = true;
    followLive.value = false;
    pathReady.value = null;
  });
  const id = await tracePath(trace);
  if (!id) return;
  const p = pathPayloads.peek().get(id);
  const q = p ? QUALITY[p.quality].label : "done";
  const r = route.peek();
  if (r.view === "trace" && r.traceId === trace.id && selectedTraceId.peek() === trace.id) {
    batch(() => {
      pathFocus.value = id;
      pathAnnounce.value = `Path traced: ${q}. ${p?.analysis?.text ?? ""}`.trim();
    });
    await loadTrace(id, "user");
  } else {
    batch(() => {
      pathReady.value = { sourceId: trace.id, traceId: id };
      pathAnnounce.value = `Path traced (${q}): open it from the source request or the request list.`;
    });
  }
}

/** The canvas Enter binding fires only on a lane's name button (other buttons keep their own Enter). */
export function enterOpensLane(target: unknown): boolean {
  const cl = (target as { classList?: { contains?: (c: string) => boolean } } | null)?.classList;
  return !!cl?.contains?.("path-lane-name");
}

/** The lane cursor clamped to `n` rows, so one lane stays tabbable. */
export function laneCursor(cursor: number, n: number): number {
  return Math.max(0, Math.min(cursor, n - 1));
}
