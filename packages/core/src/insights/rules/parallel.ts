import type { Finding, SpanRecord } from "../../types";
import { type Rule, type RuleContext, dur, fingerprint, pickLocation, roundMs, shapeOf } from "../context";

const CANDIDATE_KINDS = new Set(["db", "fetch", "function"]);

/**
 * Sibling I/O or function calls under one parent that ran strictly one after another, each taking
 * at least `parallelMinMs`, in runs of at least `parallelMinRun`. We can't see data dependencies, so
 * this is worded as a candidate.
 */
export const parallelizable: Rule = (ctx) => {
  const out: Finding[] = [];
  for (const [parentId, kids] of ctx.children) {
    const cands = kids
      .filter((s) => CANDIDATE_KINDS.has(s.kind) && !ctx.claimed.has(s.id) && dur(s) >= ctx.th.parallelMinMs)
      .sort((a, b) => a.start - b.start);
    const minRun = Math.max(2, ctx.th.parallelMinRun);
    if (cands.length < minRun) continue;
    // One finding per cause: runs under one parent that call the same things share a fingerprint,
    // and only the longest is reported (a jitter split must not turn one loop into "6/5/4 calls").
    const byFp = new Map<string, Finding>();
    const emit = (run: SpanRecord[]) => {
      if (run.length < minRun) return;
      const f = toFinding(ctx, run, parentId);
      const prev = byFp.get(f.fingerprint);
      if (!prev || (f.count ?? 0) > (prev.count ?? 0)) byFp.set(f.fingerprint, f);
    };
    let run: SpanRecord[] = [cands[0]!];
    for (let i = 1; i < cands.length; i++) {
      const prev = run[run.length - 1]!;
      const next = cands[i]!;
      if (follows(prev, next, ctx.th.parallelMaxGapMs)) run.push(next);
      else {
        emit(run);
        run = [next];
      }
    }
    emit(run);
    out.push(...byFp.values());
  }
  return out;
};

/**
 * Whether `next` ran after `prev` (sequentially). A small overlap counts as clock jitter: Windows timers
 * put back-to-back awaits 1-2ms over each other. Up to 2ms, or 15% of the shorter call, whichever is
 * larger; calls that really ran together overlap for most of their length.
 */
export function follows(prev: SpanRecord, next: SpanRecord, maxGapMs: number): boolean {
  const gap = next.start - prev.end;
  const jitter = Math.max(2, 0.15 * Math.min(dur(prev), dur(next)));
  return gap >= -jitter && gap <= maxGapMs;
}

function toFinding(ctx: RuleContext, run: SpanRecord[], parentId: string): Finding {
  const parent = ctx.byId.get(parentId);
  const owner = ctx.owner(parent ?? run[0]!);
  const durations = run.map(dur);
  const saved = durations.reduce((a, b) => a + b, 0) - Math.max(...durations);
  const names = run.map((s) => (s.kind === "function" ? s.name : (shapeOf(s) ?? s.name)));
  const where = owner.fn ?? parent?.name ?? "request";
  const f: Finding = {
    rule: "parallelizable",
    severity: "info",
    title: `${where}: ${run.length} sequential calls could run in parallel`,
    detail: `${run.map((s) => `${s.name} (${Math.round(dur(s))}ms)`).join(" -> ")}. If they don't depend on each other, Promise.all them.`,
    // The distinct callees, not the sequence: the fingerprint must not depend on the run's length.
    fingerprint: fingerprint("parallelizable", ctx.routeKey, `${where}|${[...new Set(names)].sort().join(",")}`),
    spanIds: run.map((s) => s.id),
    count: run.length,
  };
  if (owner.fn) f.fn = owner.fn;
  const loc = pickLocation(owner.location, run[0]!.location);
  if (loc) f.location = loc;
  if (saved > 0) f.estSavedMs = roundMs(saved);
  return f;
}
