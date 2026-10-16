import { describe, expect, test } from "vitest";
import type { StatsResponse } from "../src/api/types";
import { builderDimsSubject } from "../src/state/builder";
import { menuStep } from "../src/state/menuNav";
import { coreScopedStats } from "../src/state/serverStats";
import { peekStep } from "../src/state/shellKeys";

/*
 * Round 4 UI follow-ups: Space peek (plan 3.9), the copy menu's roving focus behind `y`, and the
 * builder dimming the request it was opened over (plan 5).
 * Run: pnpm --filter @hoplens/ui exec vitest run test/followups.test.ts
 */

describe("Space: peek the row under the cursor", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  test("with no subject open, Space opens the cursor row", () => {
    expect(peekStep("b", rows, { view: "requests" }, null)).toEqual({ kind: "open", id: "b" });
  });
  test("with another request open, Space shows the cursor row instead", () => {
    expect(peekStep("c", rows, { view: "trace", traceId: "a" }, "a")).toEqual({ kind: "open", id: "c" });
  });
  test("Space again on the peeked request closes the peek", () => {
    expect(peekStep("b", rows, { view: "trace", traceId: "b" }, "b")).toEqual({ kind: "close" });
  });
  test("a request opened with Enter or a click is not closed by Space", () => {
    expect(peekStep("b", rows, { view: "trace", traceId: "b" }, null)).toBeNull();
    expect(peekStep("b", rows, { view: "trace", traceId: "b" }, "a")).toBeNull();
  });
  test("no cursor, or a cursor on a row no longer listed: nothing to peek", () => {
    expect(peekStep(null, rows, { view: "requests" }, null)).toBeNull();
    expect(peekStep("gone", rows, { view: "requests" }, null)).toBeNull();
  });
});

describe("copy menu roving focus", () => {
  test("arrows wrap around the items", () => {
    expect(menuStep(0, 5, "ArrowDown")).toBe(1);
    expect(menuStep(4, 5, "ArrowDown")).toBe(0);
    expect(menuStep(0, 5, "ArrowUp")).toBe(4);
  });
  test("from outside the items, Down lands on the first and Up on the last", () => {
    expect(menuStep(-1, 5, "ArrowDown")).toBe(0);
    expect(menuStep(-1, 5, "ArrowUp")).toBe(4);
  });
  test("Home / End jump; other keys are not navigation", () => {
    expect(menuStep(2, 5, "Home")).toBe(0);
    expect(menuStep(2, 5, "End")).toBe(4);
    expect(menuStep(2, 5, "Enter")).toBeNull();
    expect(menuStep(0, 0, "ArrowDown")).toBeNull();
  });
});

describe("the builder dims the request it was opened over", () => {
  test("open over a request that is not its own result: dimmed", () => {
    expect(builderDimsSubject(true, { view: "trace", traceId: "old" }, undefined)).toBe(true);
    expect(builderDimsSubject(true, { view: "trace", traceId: "old" }, "sent")).toBe(true);
  });
  test("after Send the subject is the builder's own trace: not dimmed", () => {
    expect(builderDimsSubject(true, { view: "trace", traceId: "sent" }, "sent")).toBe(false);
  });
  test("over a compare: dimmed; closed builder or no subject: nothing to dim", () => {
    expect(builderDimsSubject(true, { view: "compare", a: "x", b: "y" }, undefined)).toBe(true);
    expect(builderDimsSubject(false, { view: "trace", traceId: "old" }, undefined)).toBe(false);
    expect(builderDimsSubject(true, { view: "requests" }, undefined)).toBe(false);
  });
});

describe("since scope: the core's own ?since= snapshot when it has one", () => {
  const base = {
    routes: [],
    totals: { requests: 7, errors: 0, cold: 0, routes: 0, droppedSpans: 0 },
    epoch: 3,
    since: 0,
    findings: [],
  } as unknown as StatsResponse;
  test("a core that answered this scope is used, with its partial flag", () => {
    const scoped = { ...base, scope: { sinceEpoch: 2, partial: true } };
    expect(coreScopedStats(scoped, 2)).toEqual({ stats: scoped, partial: true });
  });
  test("an older core (no scope echoed), another scope or no answer: fall back", () => {
    expect(coreScopedStats(base, 2)).toBeNull();
    expect(coreScopedStats({ ...base, scope: { sinceEpoch: 1, partial: false } }, 2)).toBeNull();
    expect(coreScopedStats(null, 2)).toBeNull();
  });
});
