import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  LastRuns,
  MAX_REPEAT,
  RunInputError,
  batchHttpStatus,
  parseRepeat,
  runBatch,
  summarizeBatch,
  toBatchRun,
  vsPrevious,
  warmStats,
} from "../src/replay";
import { Runtime } from "../src/runtime";
import { summarize } from "../src/store";
import { makeTrace, skeleton } from "./helpers";

/* ------------------------------------------------------------------ pure */

describe("parseRepeat", () => {
  test("absent means a single run", () => {
    expect(parseRepeat(undefined)).toBeUndefined();
    expect(parseRepeat(null)).toBeUndefined();
    expect(parseRepeat("")).toBeUndefined();
  });
  test("accepts 1-50 from query strings and numbers", () => {
    expect(parseRepeat("10")).toEqual({ n: 10, capped: false, requested: 10 });
    expect(parseRepeat(1)).toEqual({ n: 1, capped: false, requested: 1 });
  });
  test("caps above MAX_REPEAT", () => {
    expect(parseRepeat(80)).toEqual({ n: MAX_REPEAT, capped: true, requested: 80 });
    expect(MAX_REPEAT).toBe(50);
  });
  test("rejects 0, negatives, fractions and junk", () => {
    for (const bad of [0, -3, 2.5, "abc", "3x", "1e2", {}, true])
      expect(() => parseRepeat(bad), String(bad)).toThrow(RunInputError);
  });
});

describe("warmStats", () => {
  test("empty", () => expect(warmStats([])).toEqual({ n: 0 }));
  test("one sample", () => expect(warmStats([12.34])).toEqual({ n: 1, p50: 12.3, p95: 12.3, min: 12.3, max: 12.3 }));
  test("median interpolates on even n, p95 by closest ranks", () => {
    expect(warmStats([40, 10, 30, 20])).toEqual({ n: 4, p50: 25, p95: 38.5, min: 10, max: 40 });
  });
  test("ignores non-finite values", () => expect(warmStats([5, Number.NaN, 7]).n).toBe(2));
});

describe("LastRuns", () => {
  const prev = (id: string) => ({
    batchId: id,
    at: 0,
    warm: { n: 1, p50: 1, p95: 1, min: 1, max: 1 },
    coldExcluded: 0,
  });
  test("evicts the least recently used past the cap", () => {
    const l = new LastRuns(2);
    l.set("a", prev("a"));
    l.set("b", prev("b"));
    expect(l.get("a")?.batchId).toBe("a"); // a is now most recent
    l.set("c", prev("c"));
    expect(l.size).toBe(2);
    expect(l.get("b")).toBeUndefined();
    expect(l.get("a")?.batchId).toBe("a");
    expect(l.get("c")?.batchId).toBe("c");
  });
});

describe("vsPrevious", () => {
  const w = (p50: number, p95: number) => ({ n: 3, p50, p95, min: p50, max: p95 });
  test("delta in ms and percent", () => {
    expect(vsPrevious(w(120, 200), { batchId: "b", at: 0, warm: w(100, 150), coldExcluded: 0 })).toEqual({
      p50Ms: 20,
      p95Ms: 50,
      p50Pct: 0.2,
    });
  });
  test("none without a previous batch or warm runs", () => {
    expect(vsPrevious(w(1, 1), undefined)).toBeUndefined();
    expect(vsPrevious({ n: 0 }, { batchId: "b", at: 0, warm: w(1, 1), coldExcluded: 0 })).toBeUndefined();
  });
});

describe("toBatchRun / summarizeBatch", () => {
  const t = (duration: number | undefined, cold: boolean) => {
    const tr = makeTrace([], { duration });
    tr.facts = { cold } as any;
    return tr;
  };
  test("exclusion reasons", () => {
    const base = { runId: "r", status: 200, elapsed: 1 };
    expect(toBatchRun({ ...base, trace: t(10, false) }).excluded).toBeUndefined();
    expect(toBatchRun({ ...base, trace: t(10, true) }).excluded).toBe("cold");
    expect(toBatchRun({ ...base, status: 503, trace: t(10, false) }).excluded).toBe("5xx");
    expect(toBatchRun({ ...base, status: 0, error: "nope" }).excluded).toBe("error");
    expect(toBatchRun({ ...base }).excluded).toBe("no-trace");
    expect(toBatchRun({ ...base, trace: t(undefined, false) }).excluded).toBe("no-trace");
  });
  test("cold runs are counted out of warm", () => {
    const runs = [t(900, true), t(10, false), t(20, false)].map((trace) =>
      toBatchRun({ runId: "r", status: 200, elapsed: 1, trace }),
    );
    expect(summarizeBatch(runs)).toEqual({ warm: { n: 2, p50: 15, p95: 19.5, min: 10, max: 20 }, coldExcluded: 1 });
  });
});

/* ------------------------------------------------------------------ HTTP */

interface Step {
  status?: number;
  cold?: boolean;
  duration?: number;
  /** ms before the app answers. */
  delay?: number;
  /** Never finish the trace (capture lost it). */
  noTrace?: boolean;
  /** Never answer at all. */
  hang?: boolean;
}

describe("POST /api/run?repeat=N", () => {
  let rt: Runtime;
  let ui: http.Server;
  let app: http.Server;
  let uiPort: number;
  let appPort: number;
  let script: Step[] = [];
  let hits: { run?: string; batch?: string }[] = [];
  const hung: http.ServerResponse[] = [];
  let baseListeners = 0;

  beforeAll(async () => {
    rt = new Runtime({
      options: {
        port: 0,
        basePath: "",
        distDir: ".next-none",
        root: process.cwd(),
        profiles: { admin: { headers: { authorization: "Bearer x" } } },
      } as any,
      discovery: { scan: () => ({ routes: [], typescript: false, scannedAt: 0 }) },
    });
    ui = http.createServer((req, res) => rt.handleUi(req, res));
    // A fake app with its own minimal "capture": one trace per request, tagged like capture.ts does.
    app = http.createServer((req, res) => {
      const step = script.shift() ?? {};
      const run = req.headers["x-hoplens-run"] as string | undefined;
      const batch = req.headers["x-hoplens-batch"] as string | undefined;
      hits.push({ run, batch });
      const { root, handler } = skeleton(10);
      const tr = makeTrace([root, handler], {
        id: `tr_${hits.length}_${Math.random().toString(36).slice(2, 6)}`,
        runId: run,
        ...(batch ? { batchId: batch } : {}),
        done: false,
        duration: undefined,
        path: (req.url ?? "/").split("?")[0]!,
        url: req.url ?? "/",
      });
      rt.store.add(tr, { rawHeaders: {} });
      if (step.hang) {
        hung.push(res);
        return;
      }
      setTimeout(() => {
        res.statusCode = step.status ?? 200;
        res.end("ok");
        if (step.noTrace) return;
        tr.duration = step.duration ?? 10;
        tr.status = step.status ?? 200;
        tr.facts = { cold: !!step.cold } as any;
        rt.store.finish(tr);
      }, step.delay ?? 0);
    });
    await new Promise<void>((r) => ui.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
    uiPort = (ui.address() as AddressInfo).port;
    appPort = (app.address() as AddressInfo).port;
    rt.appPort = appPort;
    baseListeners = rt.store.listenerCount("done"); // the Runtime's own stats listener
  });
  afterAll(async () => {
    for (const r of hung) r.destroy();
    app.closeAllConnections?.();
    await new Promise<void>((r) => ui.close(() => r()));
    await new Promise<void>((r) => app.close(() => r()));
  });
  beforeEach(() => {
    script = [];
    hits = [];
    rt.lastRuns.clear();
    rt.appPort = appPort;
  });

  const post = async (qs: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${uiPort}/__hoplens/api/run${qs}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };

  test("runs N times sequentially with one batch id; the cold first run is excluded from warm", async () => {
    script = [{ cold: true, duration: 900 }, { duration: 10 }, { duration: 20 }, { duration: 30 }, { duration: 40 }];
    const r = await post("?repeat=5", { method: "GET", path: "/api/feed" });
    expect(r.status).toBe(200);
    expect(r.body.runs).toHaveLength(5);
    expect(r.body.coldExcluded).toBe(1);
    expect(r.body.warm).toEqual({ n: 4, p50: 25, p95: 38.5, min: 10, max: 40 });
    expect(r.body.runs[0]).toMatchObject({ cold: true, excluded: "cold", duration: 900 });
    expect(r.body.previous).toBeNull();
    expect(r.body.stopped).toBeUndefined();
    expect(r.body.key).toBe("GET /api/feed");
    // Every request carried the same batch id and its own run id; every trace was found.
    expect(new Set(hits.map((h) => h.batch))).toEqual(new Set([r.body.batchId]));
    expect(new Set(hits.map((h) => h.run)).size).toBe(5);
    const ids = r.body.runs.map((x: any) => x.traceId);
    expect(ids.every(Boolean)).toBe(true);
    expect(summarize(rt.store.get(ids[2])!).batchId).toBe(r.body.batchId);
    expect(rt.store.listenerCount("done")).toBe(baseListeners);
  });

  test("repeat in the JSON body works too, and a second batch reports vs last run", async () => {
    script = [{ duration: 100 }, { duration: 100 }];
    const a = await post("", { method: "GET", path: "/api/feed", repeat: 2 });
    expect(a.body.warm.p50).toBe(100);
    script = [{ duration: 80 }, { duration: 80 }];
    const b = await post("?repeat=2", { method: "GET", path: "/api/feed" });
    expect(b.body.previous).toMatchObject({ batchId: a.body.batchId, warm: { n: 2, p50: 100 } });
    expect(b.body.vsPrevious).toEqual({ p50Ms: -20, p95Ms: -20, p50Pct: -0.2 });
    // A different path or profile is a different key.
    script = [{ duration: 5 }];
    const c = await post("?repeat=1", { method: "GET", path: "/api/feed", profile: "admin" });
    expect(c.body.previous).toBeNull();
    expect(c.body.key).toBe("GET /api/feed @admin");
  });

  test("caps N at 50", async () => {
    const r = await post("?repeat=80", { method: "GET", path: "/api/cap" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ requested: 80, repeat: 50, capped: true });
    expect(r.body.runs).toHaveLength(50);
    expect(hits).toHaveLength(50);
  });

  test("stops at the first 5xx unless keepGoing", async () => {
    script = [{ status: 200 }, { status: 503 }, { status: 200 }];
    const r = await post("?repeat=3", { method: "GET", path: "/api/flaky" });
    expect(r.body.runs.map((x: any) => x.status)).toEqual([200, 503]);
    expect(r.body.stopped).toBe("5xx");
    expect(r.body.runs[1].excluded).toBe("5xx");
    expect(r.body.warm.n).toBe(1);

    script = [{ status: 200 }, { status: 503 }, { status: 200 }];
    const k = await post("?repeat=3&keepGoing=1", { method: "GET", path: "/api/flaky" });
    expect(k.body.runs.map((x: any) => x.status)).toEqual([200, 503, 200]);
    expect(k.body.stopped).toBeUndefined();
    expect(k.body.warm.n).toBe(2);
  });

  test("rejects a bad repeat, path or profile with 400", async () => {
    for (const qs of ["?repeat=0", "?repeat=abc", "?repeat=-1", "?repeat=2.5"]) {
      const r = await post(qs, { method: "GET", path: "/x" });
      expect(r.status, qs).toBe(400);
      expect(r.body.error).toMatch(/repeat/);
    }
    expect((await post("?repeat=2", { method: "GET", path: "x" })).status).toBe(400);
    expect((await post("?repeat=2", { method: "GET", path: "/x", profile: "nope" })).status).toBe(400);
    expect(hits).toHaveLength(0);
  });

  test("a body that is not JSON is a 400, not a crash", async () => {
    for (const qs of ["", "?repeat=2"]) {
      const r = await fetch(`http://127.0.0.1:${uiPort}/__hoplens/api/run${qs}`, { method: "POST", body: "{nope" });
      expect(r.status, qs).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/JSON/);
    }
    expect(hits).toHaveLength(0);
  });

  test("502 only when the app was never reached; a time-limited batch is a 200", () => {
    const err = { excluded: "error" as const };
    expect(batchHttpStatus({ stopped: "unreachable", runs: [err] as never })).toBe(502);
    expect(batchHttpStatus({ stopped: "timeout", runs: [err] as never })).toBe(200);
    expect(batchHttpStatus({ stopped: "unreachable", runs: [{}, err] as never })).toBe(200);
  });

  test("an unreachable app stops the batch with 502 and leaks no listener", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    rt.appPort = deadPort;
    const r = await post("?repeat=5", { method: "GET", path: "/x" });
    expect(r.status).toBe(502);
    expect(r.body.stopped).toBe("unreachable");
    expect(r.body.runs).toHaveLength(1);
    expect(r.body.runs[0].error).toMatch(/Could not reach your app/);
    const single = await post("", { method: "GET", path: "/x" });
    expect(single.status).toBe(502);
    expect(rt.store.listenerCount("done")).toBe(baseListeners);
  });

  test("the single-run response keeps its legacy shape", async () => {
    script = [{ duration: 12 }];
    const r = await post("", { method: "GET", path: "/api/one" });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["elapsed", "runId", "status", "traceId"]);
    expect(hits[0]!.batch).toBeUndefined();
  });

  test("the total time cap stops a slow batch", async () => {
    script = Array.from({ length: 10 }, () => ({ delay: 60 }));
    const t0 = Date.now();
    const r = await runBatch(rt, { method: "GET", path: "/slow" }, { n: 10, capped: false }, { totalMs: 150 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.stopped).toBe("timeout");
    expect(r.runs.length).toBeGreaterThan(0);
    expect(r.runs.length).toBeLessThan(10);
  });

  test("a hung request is aborted at the cap", async () => {
    script = [{ hang: true }];
    const t0 = Date.now();
    const r = await runBatch(rt, { method: "GET", path: "/hang" }, { n: 3, capped: false }, { totalMs: 120 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.stopped).toBe("timeout");
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ excluded: "error", error: expect.stringMatching(/time limit/) });
    expect(rt.store.listenerCount("done")).toBe(baseListeners);
  });

  test("a trace that never finishes is waited for up to traceWaitMs, then left out", async () => {
    script = [{ noTrace: true }, { duration: 7 }];
    const r = await runBatch(rt, { method: "GET", path: "/lost" }, { n: 2, capped: false }, { traceWaitMs: 50 });
    expect(r.runs[0]).toMatchObject({ status: 200, excluded: "no-trace" });
    expect(r.runs[1]!.excluded).toBeUndefined();
    expect(r.warm).toMatchObject({ n: 1, p50: 7 });
  });
});
