import { describe, expect, test } from "vitest";
import type { HealthSample, HealthSnapshot, ProcessErrorRecord } from "../src/api/types";
import {
  EMPTY_HEALTH,
  ERROR_CAP,
  SAMPLE_CAP,
  applySnapshot,
  applyTick,
  fmtLoop,
  fmtMem,
  fmtRate,
  loopLevel,
  loopView,
  requestRate,
  unseenErrors,
} from "../src/state/health";

const M = 1024 * 1024;

function sample(t: number, over: Partial<HealthSample> = {}): HealthSample {
  return {
    t,
    loopP50: 1,
    loopP99: 4,
    loopMax: 6,
    loopMean: 1.5,
    rss: 300 * M,
    heapUsed: 100 * M,
    heapTotal: 150 * M,
    external: 5 * M,
    gcCount: 0,
    gcMs: 0,
    ...over,
  };
}

function perr(id: number, kind: ProcessErrorRecord["kind"] = "unhandledRejection"): ProcessErrorRecord {
  return { id, t: 1000 + id, kind, name: "Error", message: `boom ${id}` };
}

function snapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    startedAt: 0,
    sampleMs: 2000,
    active: true,
    current: sample(10),
    samples: [sample(8), sample(10)],
    gc: { count: 0, totalMs: 0, maxMs: 0, byKind: {} },
    errors: [],
    errorCounts: { uncaughtException: 0, unhandledRejection: 0 },
    watchingRejections: true,
    ...over,
  };
}

describe("loopLevel", () => {
  test("red at 100ms p99 and above, amber from 50ms", () => {
    expect(loopLevel(4)).toBe("ok");
    expect(loopLevel(49.9)).toBe("ok");
    expect(loopLevel(50)).toBe("warn");
    expect(loopLevel(99.9)).toBe("warn");
    expect(loopLevel(100)).toBe("err");
    expect(loopLevel(2500)).toBe("err");
    expect(loopLevel(undefined)).toBe("ok");
    expect(loopLevel(Number.NaN)).toBe("ok");
  });
});

describe("loopView", () => {
  const s = (loopP99: number, loopMax: number) => ({ loopP99, loopMax });
  test("one isolated stall (max over 100ms, p99 low) is amber and shows the max", () => {
    expect(loopView([s(4, 6), s(34.47, 310.9)])).toEqual({ level: "warn", metric: "max", ms: 310.9 });
  });
  test("the worst level is held for LOOP_HOLD_SAMPLES ticks, then clears", () => {
    const stall = s(34, 300);
    const calm = s(3, 5);
    expect(loopView([stall, calm, calm])?.level).toBe("warn");
    expect(loopView([stall, calm, calm, calm])).toEqual({ level: "ok", metric: "p99", ms: 3 });
  });
  test("a sustained p99 still decides red, and outranks a held stall", () => {
    expect(loopView([s(34, 300), s(120, 400)])).toEqual({ level: "err", metric: "p99", ms: 120 });
    expect(loopView([s(120, 400), s(3, 5)])).toEqual({ level: "err", metric: "p99", ms: 120 });
    expect(loopView([])).toBeUndefined();
  });
});

describe("formatting", () => {
  test("fmtMem uses compact binary units", () => {
    expect(fmtMem(512)).toBe("512B");
    expect(fmtMem(840 * 1024)).toBe("840K");
    expect(fmtMem(312 * M)).toBe("312M");
    expect(fmtMem(1.1 * 1024 * M)).toBe("1.1G");
    expect(fmtMem(12 * 1024 * M)).toBe("12G");
    expect(fmtMem(undefined)).toBe("—");
  });
  test("fmtLoop rounds to ms, seconds from 1s", () => {
    expect(fmtLoop(3.6)).toBe("4ms");
    expect(fmtLoop(120.2)).toBe("120ms");
    expect(fmtLoop(1234)).toBe("1.2s");
  });
  test("fmtRate hides idle and trims .0", () => {
    expect(fmtRate(0)).toBe("");
    expect(fmtRate(0.3)).toBe("0.3/s");
    expect(fmtRate(4)).toBe("4/s");
    expect(fmtRate(12.4)).toBe("12/s");
  });
});

describe("requestRate", () => {
  test("counts app requests in the window, newest first, assets excluded", () => {
    const now = 100_000;
    const traces = [
      { startedAt: now - 500, kind: "route" as const },
      { startedAt: now - 1_000, kind: "asset" as const },
      { startedAt: now - 2_000, kind: "page" as const },
      { startedAt: now - 9_999, kind: "route" as const },
      { startedAt: now - 10_001, kind: "route" as const },
      { startedAt: now - 20_000, kind: "route" as const },
    ];
    expect(requestRate(traces, now)).toBeCloseTo(0.3);
    expect(requestRate(traces, now, 1_000)).toBe(1);
    expect(requestRate([], now)).toBe(0);
  });
});

describe("applySnapshot / applyTick", () => {
  test("a snapshot makes health available and keeps errors a tick raced in", () => {
    const raced = applyTick(EMPTY_HEALTH, {
      current: sample(12),
      errorCounts: { uncaughtException: 0, unhandledRejection: 2 },
      newErrors: [perr(2)],
    });
    const s = applySnapshot(raced, snapshot({ errors: [perr(1)] }));
    expect(s.availability).toBe("available");
    expect(s.errors.map((e) => e.id)).toEqual([1, 2]);
    expect(s.samples.map((x) => x.t)).toEqual([8, 10]);
  });

  test("a tick appends a newer sample once, updates counts and adds new errors", () => {
    let s = applySnapshot(EMPTY_HEALTH, snapshot());
    s = applyTick(s, {
      current: sample(12, { loopP99: 140 }),
      errorCounts: { uncaughtException: 1, unhandledRejection: 0 },
      newErrors: [perr(1, "uncaughtException")],
    });
    expect(s.current?.loopP99).toBe(140);
    expect(s.samples.map((x) => x.t)).toEqual([8, 10, 12]);
    expect(s.errorCounts.uncaughtException).toBe(1);
    expect(s.errors).toHaveLength(1);
    // The same sample again (throttled resend) and the same error again: no duplicates.
    s = applyTick(s, {
      current: sample(12, { loopP99: 140 }),
      errorCounts: { uncaughtException: 1, unhandledRejection: 0 },
      newErrors: [perr(1, "uncaughtException")],
    });
    expect(s.samples).toHaveLength(3);
    expect(s.errors).toHaveLength(1);
  });

  test("a tick without a sample (monitor off) keeps the last one", () => {
    const s = applyTick(applySnapshot(EMPTY_HEALTH, snapshot()), {
      current: null,
      errorCounts: { uncaughtException: 0, unhandledRejection: 0 },
      newErrors: [],
    });
    expect(s.current?.t).toBe(10);
    expect(s.samples).toHaveLength(2);
  });

  test("rings are capped", () => {
    const many = Array.from({ length: SAMPLE_CAP + 20 }, (_, i) => sample(i));
    const errs = Array.from({ length: ERROR_CAP + 5 }, (_, i) => perr(i + 1));
    const s = applySnapshot(EMPTY_HEALTH, snapshot({ samples: many, errors: errs }));
    expect(s.samples).toHaveLength(SAMPLE_CAP);
    expect(s.samples[0]?.t).toBe(20);
    expect(s.errors).toHaveLength(ERROR_CAP);
    expect(s.errors[0]?.id).toBe(6);
  });

  test("unseenErrors counts ids above the seen mark", () => {
    const errs = [perr(1), perr(2), perr(5)];
    expect(unseenErrors(errs, 0)).toBe(3);
    expect(unseenErrors(errs, 2)).toBe(1);
    expect(unseenErrors(errs, 5)).toBe(0);
  });
});
