import { computed } from "@preact/signals";
import type { TraceSummary } from "../api/types";
import { epochById, epochLabel, scopeStatsSince, sinceNumber, tracesSince } from "./epochs";
import { route } from "./router";
import { serverErrorTally, serverRouteStats, serverStats } from "./serverStats";
import {
  type ErrorTally,
  type FindingGroup,
  type RouteStats,
  computeRouteStats,
  errorTally,
  groupFindings,
  rankFindingGroups,
} from "./stats";
import { type MainView, clientRouteStats, finishedTraces, includeCold, statsSource } from "./store";

/*
 * The "since edit" scope (plan 3.8): an explicit chip, never a silent filter. `?since=e<n>` on the
 * route sets it; every list that applies it shows the chip (components/SinceChip), and the top bar
 * says so on a view that doesn't (Queries: its totals are kept per shape, not per edit).
 */

/** The scope's epoch, or undefined when off. */
export const sinceEpoch = computed(() => sinceNumber(route.value.since));

/** Views whose lists the scope filters. Queries can't be: the server aggregates shapes over the session. */
export function scopeApplies(view: MainView): boolean {
  return view !== "queries";
}

/** "e7 store.ts" for the chip. */
export function scopeLabel(since: number): string {
  const e = epochById.value.get(since);
  return e ? `e${since} ${epochLabel(e)}` : `e${since}`;
}

export interface OverviewScope {
  since: number;
  routes: RouteStats[];
  findings: FindingGroup[];
  errors: ErrorTally;
  requests: number;
  /** Request counts reach back past the epochs the server keeps per route: a lower bound. */
  partial: boolean;
  /** Findings come from this tab's retained requests in the scope (the server rollup isn't per edit). */
  findingsFrom: number;
}

/** Finished requests in the scope (newest first, like tracesState). */
export const scopedTraces = computed<TraceSummary[] | null>(() => {
  const since = sinceEpoch.value;
  return since === undefined ? null : tracesSince(finishedTraces.value, since);
});

/**
 * The Overview's numbers inside the scope: routes and errors from the server's per-epoch stats
 * (merged over the epochs in scope), else this tab's requests; findings from this tab's requests.
 * null when the scope is off.
 */
export const overviewScope = computed<OverviewScope | null>(() => {
  const since = sinceEpoch.value;
  const traces = scopedTraces.value;
  if (since === undefined || !traces) return null;
  const findings = rankFindingGroups(groupFindings(traces));
  const s = serverStats.value;
  if (statsSource.value === "server" && s) {
    const scoped = scopeStatsSince(s, since);
    const last = new Map<string, string>();
    for (const r of clientRouteStats.value) last.set(r.key, r.lastTraceId);
    return {
      since,
      routes: serverRouteStats(scoped.stats, last),
      findings,
      errors: serverErrorTally(scoped.stats) ?? errorTally(traces),
      requests: scoped.stats.totals.requests,
      partial: scoped.partial,
      findingsFrom: traces.length,
    };
  }
  return {
    since,
    routes: computeRouteStats(traces, includeCold.value),
    findings,
    errors: errorTally(traces),
    requests: traces.length,
    partial: false,
    findingsFrom: traces.length,
  };
});
