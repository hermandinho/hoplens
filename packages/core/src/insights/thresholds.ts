import type { FindingRule } from "../types";

/** Knobs for the findings engine. Override any subset via `insights.thresholds` in the Hoplens options. */
export interface InsightThresholds {
  /** n-plus-1: same normalized query/url under one parent at least this many times. */
  nPlusOneMin: number;
  /** duplicate: exact same query+params / method+url at least this many times. */
  duplicateMin: number;
  /** parallelizable: each sequential sibling must take at least this long (ms). */
  parallelMinMs: number;
  /** parallelizable: max gap (ms) between one sibling ending and the next starting. */
  parallelMaxGapMs: number;
  /**
   * parallelizable: shortest back-to-back run that gets reported. 3 by default: a 2-call chain is
   * usually a data dependency (geocode -> weather, list -> details).
   */
  parallelMinRun: number;
  /** slow-fn: function self time at or above this (ms) ... */
  slowFnMs: number;
  /** ... or at or above this share of the trace duration (0-1) ... */
  slowFnShare: number;
  /** ... where the share test only applies to traces at least this long (ms) ... */
  slowFnMinTraceMs: number;
  /**
   * ... and to functions with at least this much self time (ms). Without the floor a trivial route
   * (a 12ms timer in a 44ms request) flaps on timer slop.
   */
  slowFnShareMinMs: number;
  /** cold-compile: compile time at or above this (ms). Also used for the `cold` fact. */
  coldCompileMs: number;
  /** large-payload: request or response body above this many bytes. */
  largePayloadBytes: number;
}

export const DEFAULT_THRESHOLDS: Readonly<InsightThresholds> = Object.freeze({
  nPlusOneMin: 5,
  duplicateMin: 2,
  parallelMinMs: 10,
  parallelMaxGapMs: 15,
  parallelMinRun: 3,
  slowFnMs: 100,
  slowFnShare: 0.5,
  slowFnMinTraceMs: 20,
  slowFnShareMinMs: 50,
  coldCompileMs: 300,
  largePayloadBytes: 1024 * 1024,
});

export interface InsightsOptions {
  thresholds?: Partial<InsightThresholds>;
  /** Rules to skip entirely. */
  disable?: FindingRule[];
}
