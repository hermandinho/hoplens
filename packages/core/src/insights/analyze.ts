// Findings engine: runs every enabled rule over a finished trace. Pure, off the hot path (called from
// finalize() after the response finished), and each rule is isolated so one bad rule can't sink the rest.

import type { Finding, FindingRule, TraceFacts, TraceRecord } from "../types";
import { type Rule, buildContext } from "./context";
import { fetchUncached } from "./rules/cache";
import { coldCompile } from "./rules/cold";
import { duplicate } from "./rules/duplicate";
import { logsOnSuccess } from "./rules/logs";
import { nPlusOne } from "./rules/nplus1";
import { parallelizable } from "./rules/parallel";
import { largePayload } from "./rules/payload";
import { slowFn } from "./rules/slowfn";
import { swallowedError } from "./rules/swallowed";
import { DEFAULT_THRESHOLDS, type InsightThresholds, type InsightsOptions } from "./thresholds";

/** Order matters: n-plus-1 claims spans first so duplicate/parallelizable don't double-report them. */
export const RULES: ReadonlyArray<readonly [FindingRule, Rule]> = [
  ["n-plus-1", nPlusOne],
  ["duplicate", duplicate],
  ["parallelizable", parallelizable],
  ["slow-fn", slowFn],
  ["fetch-uncached", fetchUncached],
  ["cold-compile", coldCompile],
  ["large-payload", largePayload],
  ["swallowed-error", swallowedError],
  ["logs-on-success", logsOnSuccess],
];

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 } as const;

export function resolveThresholds(opts?: InsightsOptions): InsightThresholds {
  return { ...DEFAULT_THRESHOLDS, ...(opts?.thresholds ?? {}) };
}

/** Findings for one finished trace, most severe first, then by estimated savings. */
export function analyze(t: TraceRecord, facts: TraceFacts, opts?: InsightsOptions): Finding[] {
  const th = resolveThresholds(opts);
  const disabled = new Set(opts?.disable ?? []);
  const ctx = buildContext(t, facts, th);
  const out: Finding[] = [];
  for (const [name, rule] of RULES) {
    if (disabled.has(name)) continue;
    try {
      out.push(...rule(ctx));
    } catch {
      /* a broken rule must never take the trace down with it */
    }
  }
  return out.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.estSavedMs ?? 0) - (a.estSavedMs ?? 0),
  );
}
