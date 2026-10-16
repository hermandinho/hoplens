import { afterEach, describe, expect, test, vi } from "vitest";
import { HoplensApiError, api } from "../src/api/client";
import type { ReplayResult, ReplayRun, TraceSummary } from "../src/api/types";
import { jobShownForTrace } from "../src/components/ReplayPanel";
import { initialTab } from "../src/state/builder";
import {
  type ReplayJob,
  compareOffer,
  deltaTone,
  isRunning,
  liveRuns,
  medianRun,
  needsConfirm,
  pathOf,
  progressTraces,
  requestFromRaw,
  resultRuns,
  runSideBatch,
  statsLine,
  stopNote,
  stripCells,
  vsLastRun,
} from "../src/state/replay";

/*
 * Replay xN (plan 4.2 WP7) UI logic. Run: pnpm --filter @hoplens/ui exec vitest run test/replay.test.ts
 */

function run(i: number, duration: number, extra: Partial<ReplayRun> = {}): ReplayRun {
  return { runId: `r${i}`, traceId: `t${i}`, status: 200, elapsed: duration + 2, duration, cold: false, ...extra };
}

function result(runs: ReplayRun[], warm: ReplayResult["warm"], extra: Partial<ReplayResult> = {}): ReplayResult {
  return {
    batchId: "b_1",
    key: "GET /api/feed",
    requested: runs.length,
    repeat: runs.length,
    capped: false,
    runs,
    warm,
    coldExcluded: runs.filter((r) => r.excluded === "cold").length,
    previous: null,
    status: 200,
    elapsed: 1,
    ...extra,
  };
}

describe("needsConfirm", () => {
  test("repeats of a non-GET ask first; GET/HEAD/OPTIONS and single runs do not", () => {
    expect(needsConfirm("POST", 10)).toBe(true);
    expect(needsConfirm("delete", 10)).toBe(true);
    expect(needsConfirm("GET", 10)).toBe(false);
    expect(needsConfirm("HEAD", 10)).toBe(false);
    expect(needsConfirm("OPTIONS", 10)).toBe(false);
    expect(needsConfirm("POST", 1)).toBe(false);
  });
});

describe("requestFromRaw", () => {
  test("absolute url becomes path+query; batch header dropped; GET body dropped", () => {
    const req = requestFromRaw({
      method: "get",
      url: "http://localhost:3000/api/feed?fast=0",
      headers: { "x-hoplens-batch": "b_old", cookie: "a=1", "content-length": "3" },
      body: "abc",
    });
    expect(req).toEqual({ method: "GET", path: "/api/feed?fast=0", headers: { cookie: "a=1" }, body: undefined });
  });

  test("POST keeps its body; a path stays as is", () => {
    const req = requestFromRaw({ method: "POST", url: "/api/cart", headers: {}, body: '{"id":1}' });
    expect(req.path).toBe("/api/cart");
    expect(req.body).toBe('{"id":1}');
    expect(pathOf("/x?y=1")).toBe("/x?y=1");
  });
});

describe("medianRun", () => {
  test("the counted run closest to p50, skipping cold and failed runs", () => {
    const res = result(
      [
        run(1, 900, { cold: true, excluded: "cold" }),
        run(2, 300),
        run(3, 330),
        run(4, 322, { excluded: "5xx" }),
        run(5, 400),
      ],
      { n: 3, p50: 325, p95: 393 },
    );
    expect(medianRun(res)?.traceId).toBe("t3");
  });

  test("no warm p50: no median", () => {
    expect(medianRun(result([run(1, 10, { excluded: "error" })], { n: 0 }))).toBeUndefined();
  });
});

describe("stripCells", () => {
  test("one bar per run on a shared scale, pending slots for runs not done, median flagged", () => {
    const res = result([run(1, 100), run(2, 50, { cold: true, excluded: "cold" }), run(3, 200)], {
      n: 2,
      p50: 150,
    });
    const cells = stripCells(resultRuns(res), 5, "t1");
    expect(cells).toHaveLength(5);
    expect(cells.map((c) => c.kind)).toEqual(["warm", "cold", "warm", "pending", "pending"]);
    expect(cells[2]!.h).toBe(1);
    expect(cells[0]!.h).toBe(0.5);
    expect(cells[0]!.median).toBe(true);
    expect(cells[1]!.label).toContain("cold");
    expect(cells[3]!.label).toBe("Run 4: not run yet");
  });

  test("a failed run is marked fail and never median", () => {
    const res = result([run(1, 10, { status: 500, excluded: "5xx" })], { n: 0 });
    const [c] = stripCells(resultRuns(res), 1, "t1");
    expect(c!.kind).toBe("fail");
  });
});

describe("progress", () => {
  const base = { method: "GET", path: "/api/feed?fast=0", headers: {} };
  const t = (id: string, startedAt: number, extra: Partial<TraceSummary> = {}): TraceSummary => ({
    id,
    startedAt,
    method: "GET",
    path: "/api/feed",
    url: "/api/feed?fast=0",
    kind: "api",
    done: true,
    hops: 0,
    duration: 100,
    status: 200,
    batchId: "b_1",
    ...extra,
  });

  test("counts batch runs of the same request since the job started, oldest first", () => {
    const traces = [
      t("c", 1300),
      t("a", 1100),
      t("old", 10, {}),
      t("other", 1200, { url: "/api/feed?fast=1" }),
      t("nobatch", 1200, { batchId: undefined }),
      t("post", 1200, { method: "POST" }),
    ];
    const got = progressTraces(traces, { req: base, startedAt: 1050 });
    expect(got.map((x) => x.id)).toEqual(["a", "c"]);
  });

  test("live runs: only finished traces get a bar", () => {
    const runs = liveRuns([t("a", 1, { status: 503 }), t("b", 2, { done: false }), t("c", 3)]);
    expect(runs.map((r) => [r.runId, r.kind])).toEqual([
      ["a", "fail"],
      ["c", "warm"],
    ]);
  });
});

describe("deltaTone", () => {
  test("max(20%, 5ms) either way, like a regression", () => {
    expect(deltaTone(4, 10)).toBe("same");
    expect(deltaTone(5, 10)).toBe("worse");
    expect(deltaTone(50, 300)).toBe("same");
    expect(deltaTone(60, 300)).toBe("worse");
    expect(deltaTone(-60, 300)).toBe("better");
  });
});

describe("vsLastRun", () => {
  test("first replay says so", () => {
    expect(vsLastRun(result([run(1, 10)], { n: 1, p50: 10 }), 0)?.text).toBe(
      "First replay of GET /api/feed this session",
    );
  });

  test("p50 and p95 against the previous batch, with the tone", () => {
    const res = result(
      [run(1, 323)],
      { n: 1, p50: 323, p95: 410 },
      {
        previous: { batchId: "b_0", at: 0, warm: { n: 9, p50: 239, p95: 260 }, coldExcluded: 1 },
      },
    );
    const vs = vsLastRun(res, 120_000)!;
    expect(vs.text).toBe("vs last run 2m ago: p50 239ms -> 323ms (+35%), p95 260ms -> 410ms");
    expect(vs.tone).toBe("worse");
  });
});

describe("compareOffer", () => {
  const res = result([run(1, 300), run(2, 320), run(3, 340)], { n: 3, p50: 320 });

  test("from a trace: offered when the trace is off the median by max(20%, 5ms)", () => {
    expect(compareOffer(res, { traceId: "src", ms: 611 })).toMatchObject({ a: "t2", b: "src" });
    expect(compareOffer(res, { traceId: "src", ms: 330 })).toBeNull();
  });

  test("from the builder: slowest vs median only when the spread is real", () => {
    expect(compareOffer(res)).toBeNull();
    const wide = result([run(1, 300), run(2, 320), run(3, 600)], { n: 3, p50: 320 });
    expect(compareOffer(wide)).toMatchObject({ a: "t2", b: "t3" });
  });
});

describe("text lines", () => {
  test("stats line names warm, cold and failed counts", () => {
    const res = result(
      [run(1, 900, { cold: true, excluded: "cold" }), run(2, 300), run(3, 330), run(4, 1, { excluded: "5xx" })],
      { n: 2, p50: 315, p95: 328.5, min: 300, max: 330 },
    );
    expect(statsLine(res)).toBe("p50 315ms · p95 329ms · 300ms-330ms · 2 warm, 1 cold left out, 1 failed");
  });

  test("stop note only when the batch ended early", () => {
    expect(stopNote(result([run(1, 1)], { n: 1 }))).toBeUndefined();
    expect(stopNote({ stopped: "5xx", runs: [run(1, 1)], repeat: 10 })).toBe(
      "Stopped after 1 of 10: the app answered 5xx",
    );
  });
});

describe("jobShownForTrace", () => {
  const job = (source: ReplayJob["source"], runs: ReplayRun[] = []): ReplayJob => ({
    id: 1,
    source,
    req: { method: "GET", path: "/" },
    n: 10,
    phase: runs.length ? "done" : "running",
    startedAt: 0,
    result: runs.length ? result(runs, { n: runs.length }) : undefined,
  });

  test("a trace job shows on its source and on its runs", () => {
    const j = job({ kind: "trace", traceId: "src" }, [run(1, 1)]);
    expect(jobShownForTrace(j, "src", false)).toBe(true);
    expect(jobShownForTrace(j, "t1", false)).toBe(true);
    expect(jobShownForTrace(j, "x", false)).toBe(false);
  });

  test("a builder job shows on its runs only while the builder is closed", () => {
    const j = job({ kind: "builder", routeKey: "r::GET" }, [run(1, 1)]);
    expect(jobShownForTrace(j, "t1", false)).toBe(true);
    expect(jobShownForTrace(j, "t1", true)).toBe(false);
  });
});

describe("builder initialTab", () => {
  test("GET opens on Query, POST on Body", () => {
    expect(initialTab("GET")).toBe("query");
    expect(initialTab("POST")).toBe("body");
  });
});

describe("runSideBatch (Changes replay x10 shares the job's runner)", () => {
  afterEach(() => vi.restoreAllMocks());

  test("a 502 that still carries the batch resolves as a result", async () => {
    const body = { runs: [], repeat: 10, key: "GET /x" };
    vi.spyOn(api, "run").mockRejectedValue(new HoplensApiError(502, JSON.stringify(body), "/run"));
    await expect(runSideBatch({ method: "GET", path: "/x" })).resolves.toMatchObject({ repeat: 10 });
  });

  test("a 400 rejects with the core's error", async () => {
    vi.spyOn(api, "run").mockRejectedValue(new HoplensApiError(400, JSON.stringify({ error: "bad path" }), "/run"));
    await expect(runSideBatch({ method: "GET", path: "x" })).rejects.toThrow("bad path");
  });

  test("r / R wait while it is open", async () => {
    let release: (v: unknown) => void = () => {};
    vi.spyOn(api, "run").mockReturnValue(new Promise((r) => (release = r)) as never);
    const p = runSideBatch({ method: "GET", path: "/x" });
    expect(isRunning()).toBe(true);
    release({ runs: [], repeat: 10 });
    await p;
    expect(isRunning()).toBe(false);
  });
});
