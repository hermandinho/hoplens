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
    let run: SpanRecord[] = [cands[0]!];
    for (let i = 1; i < cands.length; i++) {
      const prev = run[run.length - 1]!;
      const next = cands[i]!;
      const gap = next.start - prev.end;
      // Tolerate sub-ms clock jitter as "after".
      if (gap >= -0.5 && gap <= ctx.th.parallelMaxGapMs) run.push(next);
      else {
        if (run.length >= minRun) out.push(toFinding(ctx, run, parentId));
        run = [next];
      }
    }
    if (run.length >= minRun) out.push(toFinding(ctx, run, parentId));
  }
  return out;
};

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
    fingerprint: fingerprint("parallelizable", ctx.routeKey, `${where}|${names.join(",")}`),
    spanIds: run.map((s) => s.id),
    count: run.length,
  };
  if (owner.fn) f.fn = owner.fn;
  const loc = pickLocation(owner.location, run[0]!.location);
  if (loc) f.location = loc;
  if (saved > 0) f.estSavedMs = roundMs(saved);
  return f;
}
