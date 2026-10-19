// Request path P1: the capture window (path/capture.ts) with a fake coverage source and a fake
// store, the project-script filter, the store's in-flight counter, the c8 refusal and the
// never-stop rule of coverage.ts.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import * as pathApi from "../src/api/path";
import { captureDeps } from "../src/api/path";
import {
  type CaptureDeps,
  MAX_LANES,
  PathError,
  PathResults,
  buildPayload,
  capturePath,
  isProjectScript,
  pathMeta,
  stackLines,
} from "../src/path/capture";
import type { CoverageSource, FunctionCoverage, ScriptCoverage, TakeResult } from "../src/path/coverage";
import { BlockWatch, startCoverage } from "../src/path/coverage";
import { TraceStore, summarize } from "../src/store";
import type { TraceRecord } from "../src/types";
import { makeTrace, span } from "./helpers";

const ROOT = path.resolve("/proj");

const ROUTE = `import { find } from "./s.js";
app.get("/x/:id", async (req, res) => {
  if (!(await find(1))) return res.end();
  res.end("ok");
});
`;
const SVC = `export async function find(id) {
  return id ?? null;
}
`;
const FILES: Record<string, string> = {
  [path.join(ROOT, "src", "r.js")]: ROUTE,
  [path.join(ROOT, "src", "s.js")]: SVC,
};
const url = (rel: string) => pathToFileURL(path.join(ROOT, rel)).href;

/** Coverage of one run: the handler once, find() `findCalls` times. */
function scripts(findCalls = 1, handlerCalls = 1): ScriptCoverage[] {
  const h = ROUTE.indexOf("async (req");
  const hEnd = ROUTE.lastIndexOf("}") + 1;
  const thenAt = ROUTE.indexOf("return res.end()");
  const handler: FunctionCoverage = {
    functionName: "",
    isBlockCoverage: true,
    ranges: [
      { startOffset: h, endOffset: hEnd, count: handlerCalls },
      { startOffset: thenAt, endOffset: thenAt + 16, count: 0 },
    ],
  };
  const f = SVC.indexOf("async function");
  const find: FunctionCoverage = {
    functionName: "find",
    isBlockCoverage: true,
    ranges: [
      { startOffset: f, endOffset: SVC.length - 1, count: findCalls },
      { startOffset: SVC.indexOf("null"), endOffset: SVC.indexOf("null") + 4, count: 0 },
    ],
  };
  const module = (text: string): FunctionCoverage => ({
    functionName: "",
    isBlockCoverage: true,
    ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }],
  });
  return [
    { scriptId: "1", url: url("src/r.js"), functions: [module(ROUTE), handler] },
    { scriptId: "2", url: url("src/s.js"), functions: [module(SVC), find] },
    { scriptId: "3", url: url("node_modules/express/index.js"), functions: [] },
    { scriptId: "4", url: "node:internal/x", functions: [] },
  ];
}

/** A replayed trace: request -> handler (r.js:2) -> find (s.js:1) x `finds`. */
function replayTrace(id: string, finds = 1): TraceRecord {
  const root = span({ kind: "request", name: "GET /x/1", start: 0, end: 10 });
  const handler = span({
    kind: "handler",
    name: "GET /x/:id",
    parentId: root.id,
    start: 1,
    end: 9,
    location: { file: "src/r.js", line: 2 },
  });
  const fns = Array.from({ length: finds }, (_, i) =>
    span({
      kind: "function",
      name: "find",
      parentId: handler.id,
      start: 2 + i,
      end: 3 + i,
      location: { file: "src/s.js", line: 1 },
    }),
  );
  return makeTrace([root, handler, ...fns], { id, url: "/x/1", path: "/x/1" });
}

class FakeStore extends EventEmitter {
  running = 0;
  inflight() {
    return this.running;
  }
  inflightTraces() {
    return Array.from({ length: this.running }, (_, i) =>
      makeTrace([], { id: `busy${i}`, path: "/slow", method: "GET" }),
    );
  }
}

class FakeCoverage implements CoverageSource {
  state: CoverageSource["state"] = "on";
  reason?: string;
  log: string[] = [];
  /** Coverage the next final takes return (one entry per attempt; the last one repeats). */
  runs: ScriptCoverage[][] = [scripts()];
  private takes = 0;
  take(keep?: (url: string) => boolean): TakeResult | undefined {
    this.takes++;
    // Odd takes are resets, even takes the final ones.
    const final = this.takes % 2 === 0;
    this.log.push(final ? "take" : "reset");
    const all = final ? (this.runs.shift() ?? scripts()) : scripts();
    if (final && this.runs.length === 0) this.runs.push(all);
    const kept = keep ? all.filter((s) => keep(s.url)) : all;
    return { scripts: kept, total: all.length, ms: 1 };
  }
}

const FAST = { quietMs: 20, quietMaxMs: 200, pollMs: 5, settleMs: 20, settleMaxMs: 200 };

function deps(over: Partial<CaptureDeps> & { cov?: FakeCoverage; st?: FakeStore } = {}) {
  const cov = over.cov ?? new FakeCoverage();
  const store = over.st ?? new FakeStore();
  let n = 0;
  const fired: string[] = [];
  const d: CaptureDeps = {
    coverage: cov,
    store,
    root: ROOT,
    readSource: (abs) => FILES[abs],
    timings: FAST,
    fire: async () => {
      cov.log.push("fire");
      const t = replayTrace(`tr_new${++n}`);
      fired.push(t.id);
      store.emit("start", t);
      await new Promise((r) => setTimeout(r, 2));
      return { trace: t, status: 200 };
    },
    ...over,
  };
  return { d, cov, store, fired };
}

const SOURCE = replayTrace("tr_src");

async function refusal(p: Promise<unknown>): Promise<PathError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PathError) return err;
    throw err;
  }
  throw new Error("expected a PathError");
}

describe("capturePath: refusals", () => {
  test("non-GET source traces get 400 with a reason, nothing fired", async () => {
    const { d, cov } = deps();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const err = await refusal(capturePath(d, makeTrace([], { method, id: "tr_post" })));
      expect(err.status).toBe(400);
      expect(err.body.code).toBe("method");
    }
    expect(cov.log).toEqual([]);
  });

  test("HEAD is allowed", async () => {
    const { d } = deps();
    const p = await capturePath(d, makeTrace(SOURCE.spans, { id: "tr_head", method: "HEAD" }));
    expect(p.quality).toBe("exact");
  });

  test("no coverage handle (HOPLENS_PATH unset) answers 409 path off", async () => {
    const { d } = deps({ coverage: undefined });
    const err = await refusal(capturePath(d, SOURCE));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: "path-off", state: "off" });
    expect(err.body.error).toMatch(/HOPLENS_PATH=1/);
  });

  test("coverage disabled under c8 answers 409 path off with that state", async () => {
    const cov = new FakeCoverage();
    cov.state = "disabled-c8";
    cov.reason = "NODE_V8_COVERAGE is set";
    const { d } = deps({ cov });
    const err = await refusal(capturePath(d, SOURCE));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: "path-off", state: "disabled-c8" });
    expect(cov.log).toEqual([]);
  });

  test("quiet gate: a request that stays in flight gets 409 not-quiet and the app sees nothing", async () => {
    const { d, store, cov, fired } = deps();
    store.running = 2;
    const t0 = Date.now();
    const err = await refusal(capturePath(d, SOURCE));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: "not-quiet", inflight: 2, reason: "2 requests in flight" });
    expect(err.body.requests).toEqual(["GET /slow", "GET /slow"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.quietMaxMs - 10);
    expect(fired).toEqual([]);
    expect(cov.log).toEqual([]);
  });

  test("quiet gate: waits for the app to go idle for quietMs, then fires", async () => {
    const { d, store, cov } = deps();
    store.running = 1;
    setTimeout(() => (store.running = 0), 40);
    const p = await capturePath(d, SOURCE);
    expect(p.window.quietMs).toBeGreaterThanOrEqual(40 + FAST.quietMs - 10);
    expect(cov.log).toEqual(["reset", "fire", "take"]);
  });

  test("a running Replay xN batch refuses before firing", async () => {
    const { d, fired } = deps({ busy: () => "a Replay xN batch is running" });
    const err = await refusal(capturePath(d, SOURCE));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: "not-quiet", reason: "a Replay xN batch is running" });
    expect(fired).toEqual([]);
  });

  test("mutex: a second capture while one runs gets 409 busy; the lock is released after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d } = deps();
    const fire = d.fire;
    d.fire = async () => {
      await gate;
      return fire();
    };
    const first = capturePath(d, SOURCE);
    await new Promise((r) => setTimeout(r, FAST.quietMs + 20));
    const err = await refusal(capturePath(d, SOURCE));
    expect(err.status).toBe(409);
    expect(err.body.code).toBe("busy");
    release();
    expect((await first).quality).toBe("exact");
    expect((await capturePath(d, SOURCE)).quality).toBe("exact");
  });

  test("a replay that never produced a trace is 502", async () => {
    const { d } = deps({ fire: async () => ({ status: 0, error: "Could not reach your app on port 1" }) });
    const err = await refusal(capturePath(d, SOURCE));
    expect(err.status).toBe(502);
    expect(err.body.error).toMatch(/Could not reach/);
  });
});

describe("capturePath: the window", () => {
  test("EXACT: reset before the fire, lanes in span order with function truth and raw ranges", async () => {
    const { d, cov } = deps();
    const p = await capturePath(d, SOURCE);
    expect(cov.log).toEqual(["reset", "fire", "take"]);
    expect(p).toMatchObject({ v: 2, traceId: "tr_new1", replayOf: "tr_src", quality: "exact", contamination: [] });
    expect(p.window.retries).toBe(0);
    // r.js and s.js: node_modules and node: scripts are dropped.
    expect(p.window.scripts).toBe(2);
    expect(p.window.totalScripts).toBe(4);
    expect(p.lanes.map((l) => [l.kind, l.name, l.file, l.line, l.depth, l.calls, l.truth])).toEqual([
      ["handler", "GET /x/:id", "src/r.js", 2, 0, 1, { t: "taken", n: 1 }],
      ["function", "find", "src/s.js", 1, 1, 1, { t: "taken", n: 1 }],
    ]);
    const find = p.functions["src/s.js:1:find"]!;
    expect(find).toMatchObject({ mapping: "identity", v8Name: "find", blocks: true, startLine: 1, endLine: 3 });
    expect(find.calls).toEqual({ hops: 1, coverage: 1, checked: true });
    expect(find.ranges.map((r) => [r.line, r.count])).toEqual([
      [1, 1],
      [2, 0],
    ]);
    expect(find.ranges[1]!.start).toBe(SVC.indexOf("null"));
    expect(find.sourceHash).toMatch(/^[0-9a-f]{12}$/);
    const handler = p.functions["src/r.js:2:GET /x/:id"]!;
    expect(handler.calls).toEqual({ hops: 1, coverage: 1, checked: true });
    expect(handler.ranges.map((r) => [r.line, r.count])).toEqual([
      [2, 1],
      [3, 0],
    ]);
  });

  test("the new trace is stamped as a path trace of the source", async () => {
    let made: TraceRecord | undefined;
    const { d } = deps();
    const fire = d.fire;
    d.fire = async () => {
      const r = await fire();
      made = r.trace;
      return r;
    };
    await capturePath(d, SOURCE);
    expect(made?.pathTrace).toEqual({ quality: "exact", replayOf: "tr_src" });
  });

  test("taint on both tries: one retry, then CONTAMINATED with every truth unknown and a warning", async () => {
    const { d, store, cov, fired } = deps();
    const fire = d.fire;
    d.fire = async () => {
      store.emit("start", makeTrace([], { id: "tr_foreign", method: "GET", path: "/timer" }));
      return fire();
    };
    const p = await capturePath(d, SOURCE);
    expect(fired).toEqual(["tr_new1", "tr_new2"]);
    expect(cov.log).toEqual(["reset", "fire", "take", "reset", "fire", "take"]);
    expect(p.quality).toBe("contaminated");
    expect(p.traceId).toBe("tr_new2");
    expect(p.window.retries).toBe(1);
    expect(p.window.taint).toEqual(["GET /timer"]);
    expect(p.contamination[0]).toMatch(/other requests ran during the capture: GET \/timer/);
    expect(p.warnings[0]).toMatch(/every decision is UNKNOWN/);
    for (const lane of p.lanes) expect(lane.truth).toEqual({ t: "unknown", why: "contaminated" });
    for (const fn of Object.values(p.functions)) expect(fn.truth).toEqual({ t: "unknown", why: "contaminated" });
    // The raw ranges are kept (the capture is kept, not discarded).
    expect(p.functions["src/s.js:1:find"]!.ranges.length).toBe(2);
  });

  test("taint on the first try only: the retry is EXACT", async () => {
    const { d, store } = deps();
    const fire = d.fire;
    let n = 0;
    d.fire = async () => {
      if (++n === 1) store.emit("start", makeTrace([], { id: "tr_foreign", path: "/other" }));
      return fire();
    };
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("exact");
    expect(p.window.retries).toBe(1);
    expect(p.traceId).toBe("tr_new2");
  });

  test("K > H (coverage saw more calls than hops) contaminates; a clean retry is EXACT", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts(3), scripts(1)];
    const { d } = deps({ cov });
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("exact");
    expect(p.window.retries).toBe(1);
  });

  test("K > H on both tries with different excess: CONTAMINATED naming the function", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts(3), scripts(2)];
    const { d } = deps({ cov });
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("contaminated");
    expect(p.contamination).toEqual(["src/s.js:1:find ran 1 more time(s) than its hops (K > H)"]);
  });

  test("the same K > H on both clean tries is calls the hops cannot see: PARTIAL, unchecked", async () => {
    const cov = new FakeCoverage();
    // Both tries, then a control window where nothing ran.
    cov.runs = [scripts(2), scripts(2), scripts(0, 0)];
    const { d } = deps({ cov });
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("partial");
    expect(p.contamination).toEqual([]);
    expect(p.functions["src/s.js:1:find"]!.calls).toEqual({ hops: 1, coverage: 2, checked: false });
    expect(p.warnings.join("\n")).toMatch(/local binding/);
  });

  test("K < H is a join mismatch: that lane is unknown and the capture PARTIAL", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts(1)];
    const { d, store } = deps({ cov });
    d.fire = async () => {
      const t = replayTrace("tr_two", 2);
      store.emit("start", t);
      return { trace: t, status: 200 };
    };
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("partial");
    expect(p.functions["src/s.js:1:find"]!.truth).toEqual({ t: "unknown", why: "join-mismatch" });
    expect(p.lanes.filter((l) => l.name === "find").map((l) => l.calls)).toEqual([2, 2]);
  });

  test("settle: each update of our trace extends the window, foreign updates do not", async () => {
    const { d, store } = deps({ timings: { ...FAST, settleMs: 40, settleMaxMs: 500 } });
    const fire = d.fire;
    d.fire = async () => {
      const r = await fire();
      const t = r.trace!;
      setTimeout(() => store.emit("update", t), 30);
      setTimeout(() => store.emit("update", t), 60);
      setTimeout(() => store.emit("update", makeTrace([], { id: "tr_x" })), 150);
      return r;
    };
    const p = await capturePath(d, SOURCE);
    // 60 + 40, not 40 (no extension) and not 150 + 40 (the foreign update).
    expect(p.window.settleMs).toBeGreaterThanOrEqual(90);
    expect(p.window.settleMs).toBeLessThan(180);
  });

  test("settle: extensions stop at settleMaxMs", async () => {
    // settleMs well above the 10ms update interval: under load the interval can stall, and a stall
    // longer than settleMs ends the window early (that's the window working, not the cap).
    const { d, store } = deps({ timings: { ...FAST, settleMs: 150, settleMaxMs: 400 } });
    const fire = d.fire;
    let timer: ReturnType<typeof setInterval> | undefined;
    d.fire = async () => {
      const r = await fire();
      timer = setInterval(() => store.emit("update", r.trace!), 10);
      return r;
    };
    const p = await capturePath(d, SOURCE);
    clearInterval(timer);
    // Updates never stop, so only the cap ends the window: at 400ms, not 150 and not unbounded.
    expect(p.window.settleMs).toBeGreaterThanOrEqual(395);
    expect(p.window.settleMs).toBeLessThan(1500);
  });

  test("lanes follow the span tree even when a callee's span starts before its handler's", async () => {
    const { d, store } = deps();
    d.fire = async () => {
      const t = replayTrace("tr_order");
      const handler = t.spans.find((s) => s.kind === "handler")!;
      handler.start = 5; // after find (start 2)
      t.spans.sort((a, b) => a.start - b.start);
      store.emit("start", t);
      return { trace: t, status: 200 };
    };
    const p = await capturePath(d, SOURCE);
    expect(p.lanes.map((l) => [l.kind, l.depth])).toEqual([
      ["handler", 0],
      ["function", 1],
    ]);
  });

  test("a hop whose file V8 never ran (no script) is unknown join-mismatch", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts().filter((s) => !s.url.endsWith("s.js"))];
    const { d } = deps({ cov });
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("partial");
    expect(p.functions["src/s.js:1:find"]!.truth).toEqual({ t: "unknown", why: "join-mismatch" });
    expect(p.functions["src/s.js:1:find"]!.calls.coverage).toBeNull();
  });
});

describe("isProjectScript", () => {
  test("keeps project file:// scripts only", () => {
    expect(isProjectScript(url("src/a.js"), ROOT)).toBe(true);
    expect(isProjectScript(`${url("src/a.mjs")}?v=2`, ROOT)).toBe(true);
    expect(isProjectScript(url("node_modules/x/a.js"), ROOT)).toBe(false);
    expect(isProjectScript(url("src/node_modules/x/a.js"), ROOT)).toBe(false);
    expect(isProjectScript(url(".next/server/a.js"), ROOT)).toBe(false);
    expect(isProjectScript(url("node_modules/@hoplens/core/dist/index.js"), ROOT)).toBe(false);
    expect(isProjectScript(url("vendor/@hoplens/x.js"), ROOT)).toBe(false);
    expect(isProjectScript(pathToFileURL(path.resolve("/other/a.js")).href, ROOT)).toBe(false);
    expect(isProjectScript(pathToFileURL(path.resolve("/proj-two/a.js")).href, ROOT)).toBe(false);
    expect(isProjectScript("node:internal/modules/cjs/loader", ROOT)).toBe(false);
    expect(isProjectScript("", ROOT)).toBe(false);
    expect(isProjectScript("evalmachine.<anonymous>", ROOT)).toBe(false);
  });
});

describe("PathResults", () => {
  test("keeps the last 20 by trace id", () => {
    const r = new PathResults();
    for (let i = 0; i < 25; i++) r.set(`t${i}`, { traceId: `t${i}` } as any);
    expect(r.size).toBe(20);
    expect(r.get("t4")).toBeUndefined();
    expect(r.get("t5")?.traceId).toBe("t5");
  });
});

describe("TraceStore.inflight", () => {
  test("counts started, unfinished requests, even when evicted or cleared", () => {
    const store = new TraceStore(1);
    const a = makeTrace([], { id: "a", done: false });
    const b = makeTrace([], { id: "b", done: false });
    store.add(a, { rawHeaders: {} });
    store.add(b, { rawHeaders: {} });
    expect(store.inflight()).toBe(2);
    expect(store.inflightTraces().map((t) => t.id)).toEqual(["a", "b"]);
    store.finish(a); // evicted already: still leaves the in-flight set
    expect(store.inflight()).toBe(1);
    store.clear();
    expect(store.inflight()).toBe(1);
    store.finish(b);
    expect(store.inflight()).toBe(0);
    store.finish(b);
    expect(store.inflight()).toBe(0);
  });
});

describe("coverage.ts", () => {
  const KEY = Symbol.for("hoplens.coverage");
  afterEach(() => {
    delete (globalThis as any)[KEY];
  });

  test("refuses under NODE_V8_COVERAGE without touching the inspector", () => {
    const cov = startCoverage({ HOPLENS_PATH: "1", NODE_V8_COVERAGE: "/tmp/c8" });
    expect(cov.state).toBe("disabled-c8");
    expect(cov.take()).toBeUndefined();
    expect(pathMeta(cov)).toMatchObject({ state: "disabled-c8" });
    // Idempotent: the first call wins.
    expect(startCoverage({ HOPLENS_PATH: "1" })).toBe(cov);
  });

  test("pathMeta without a handle says how to turn it on", () => {
    expect(pathMeta(undefined, {})).toEqual({ state: "off", reason: "restart with HOPLENS_PATH=1", source: "default" });
    expect(pathMeta(undefined, { HOPLENS_PATH: "1" }).reason).toMatch(/did not start at boot/);
  });

  test("never stops coverage and never enables the debugger (static)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "path", "coverage.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/stopPreciseCoverage/);
    expect(code).not.toMatch(/Debugger\./);
    expect(code).toMatch(/startPreciseCoverage", \{ callCount: true, detailed: true \}/);
  });
});

/* ------------------------------------------------- review round (P1 fixes) */

/** Coverage where the handler's not-taken arm counts `armCount` with the handler entered once. */
function scriptsArm(armCount: number): ScriptCoverage[] {
  const all = scripts();
  const handler = all[0]!.functions[1]!;
  handler.ranges[1]!.count = armCount;
  return all;
}

const LOOP = `export function sum(xs) {
  let t = 0;
  for (const x of xs) {
    t += x;
  }
  return t;
}
`;

describe("capturePath: late work from other requests", () => {
  test("a foreign trace's late span inside the window taints it; the clean retry is EXACT", async () => {
    const { d, store } = deps();
    const fire = d.fire;
    let n = 0;
    d.fire = async () => {
      if (++n === 1) store.emit("update", makeTrace([], { id: "tr_old", method: "GET", path: "/old" }));
      return fire();
    };
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("exact");
    expect(p.window.retries).toBe(1);
    expect(p.window.attempts).toEqual([
      {
        traceId: "tr_new1",
        quality: "contaminated",
        contamination: [expect.stringMatching(/late work from GET \/old/)],
      },
    ]);
  });

  test("a block counted more often than its function was entered, outside any loop, contaminates", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scriptsArm(2), scriptsArm(2)];
    const { d } = deps({ cov });
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("contaminated");
    expect(p.window.retries).toBe(1);
    expect(p.contamination.join("\n")).toMatch(/src\/r\.js:2:GET \/x\/:id: a block ran 2 times in 1 call/);
  });

  test("the same block count inside a loop is plausible", async () => {
    const files = { ...FILES, [path.join(ROOT, "src", "l.js")]: LOOP };
    const cov = new FakeCoverage();
    const body = LOOP.indexOf("{\n    t +=");
    const loopScripts = (): ScriptCoverage[] => [
      ...scripts(),
      {
        scriptId: "9",
        url: url("src/l.js"),
        functions: [
          {
            functionName: "sum",
            isBlockCoverage: true,
            ranges: [
              { startOffset: 0, endOffset: LOOP.length - 1, count: 1 },
              { startOffset: body, endOffset: body + 18, count: 3 },
            ],
          },
        ],
      },
    ];
    cov.runs = [loopScripts()];
    const { d, store } = deps({ cov, readSource: (abs) => files[abs] });
    d.fire = async () => {
      const t = replayTrace("tr_loop");
      t.spans.push(
        span({
          kind: "function",
          name: "sum",
          parentId: t.spans[1]!.id,
          start: 5,
          end: 6,
          location: { file: "src/l.js", line: 1 },
        }),
      );
      store.emit("start", t);
      return { trace: t, status: 200 };
    };
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("exact");
    expect(p.functions["src/l.js:1:sum"]!.truth).toEqual({ t: "taken", n: 1 });
  });
});

describe("capturePath: the control window", () => {
  test("same K > H on both tries but the joined functions also ran with no replay: CONTAMINATED", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts(2), scripts(2), scripts(1, 0)];
    const { d } = deps({ cov });
    const p = await capturePath(d, SOURCE);
    expect(cov.log).toEqual(["reset", "fire", "take", "reset", "fire", "take", "reset", "take"]);
    expect(p.quality).toBe("contaminated");
    expect(p.window.control).toMatchObject({ clean: false });
    expect(p.contamination.join("\n")).toMatch(/background work/);
    expect(p.functions["src/s.js:1:find"]!.truth).toEqual({ t: "unknown", why: "contaminated" });
  });

  test("a clean control window keeps the local-binding PARTIAL", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts(2), scripts(2), scripts(0, 0)];
    const { d } = deps({ cov });
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("partial");
    expect(p.window.control).toMatchObject({ clean: true });
  });
});

describe("capturePath: capped hops and lanes", () => {
  test("a trace that dropped function spans skips K > H: PARTIAL with hops capped, no retry", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts(5)];
    const { d, store } = deps({ cov });
    d.fire = async () => {
      const t = replayTrace("tr_cap");
      t.facts = { droppedSpans: 4 } as any;
      store.emit("start", t);
      return { trace: t, status: 200 };
    };
    const p = await capturePath(d, SOURCE);
    expect(p.window.retries).toBe(0);
    expect(p.quality).toBe("partial");
    expect(p.functions["src/s.js:1:find"]!.calls.checked).toBe(false);
    expect(p.warnings.join("\n")).toMatch(/hops capped/);
  });

  test("late spans counted in facts.droppedSpans are recorded hops, not capped ones: no 'hops capped'", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts(1)];
    const { d, store } = deps({ cov });
    d.fire = async () => {
      const t = replayTrace("tr_late");
      // A late span is still pushed to spans (attrs hoplens.late) and bumps facts.droppedSpans.
      const last = t.spans[t.spans.length - 1]!;
      last.attrs = { ...last.attrs, "hoplens.late": true };
      t.facts = { droppedSpans: 1 } as any;
      store.emit("start", t);
      return { trace: t, status: 200 };
    };
    const p = await capturePath(d, SOURCE);
    expect(p.warnings.join("\n")).not.toMatch(/hops capped/);
    expect(p.functions["src/s.js:1:find"]!.calls.checked).toBe(true);
  });

  test("lanes are capped", async () => {
    const cov = new FakeCoverage();
    cov.runs = [scripts(MAX_LANES + 50)];
    const { d, store } = deps({ cov });
    d.fire = async () => {
      const t = replayTrace("tr_many", MAX_LANES + 50);
      store.emit("start", t);
      return { trace: t, status: 200 };
    };
    const p = await capturePath(d, SOURCE);
    expect(p.lanes.length).toBe(MAX_LANES);
    expect(p.quality).toBe("partial");
    expect(p.warnings.join("\n")).toMatch(/lanes not shown/);
  });
});

describe("capturePath: no block counts", () => {
  test("a joined function V8 kept only a function count for is unknown no-blocks, never EXACT", async () => {
    const cov = new FakeCoverage();
    const s = scripts();
    s[1]!.functions[1]!.isBlockCoverage = false;
    cov.runs = [s];
    const { d } = deps({ cov });
    const p = await capturePath(d, SOURCE);
    expect(p.quality).toBe("partial");
    expect(p.functions["src/s.js:1:find"]!.truth).toEqual({ t: "unknown", why: "no-blocks" });
  });

  test("BlockWatch: a function seen with block counts that comes back without them is a downgrade", () => {
    const w = new BlockWatch();
    const fn = (block: boolean): ScriptCoverage[] => [
      {
        scriptId: "1",
        url: "file:///a.js",
        functions: [
          { functionName: "f", isBlockCoverage: block, ranges: [{ startOffset: 4, endOffset: 9, count: 1 }] },
        ],
      },
    ];
    expect(w.downgraded(fn(false))).toBe(false); // compiled before coverage started: not a downgrade
    expect(w.downgraded(fn(true))).toBe(false);
    expect(w.downgraded(fn(true))).toBe(false);
    expect(w.downgraded(fn(false))).toBe(true);
  });

  test("BlockWatch: another function at the same start offset is not a downgrade", () => {
    const w = new BlockWatch();
    const at = (name: string, end: number, block: boolean): ScriptCoverage[] => [
      {
        scriptId: "1",
        url: "file:///a.js",
        functions: [
          { functionName: name, isBlockCoverage: block, ranges: [{ startOffset: 0, endOffset: end, count: 1 }] },
        ],
      },
    ];
    expect(w.downgraded(at("", 4089, true))).toBe(false);
    // Seen on pg's cert-signatures.js: an uncompiled function reported at offset 0.
    expect(w.downgraded(at("x509Error", 148, false))).toBe(false);
  });

  test("a take that finds coverage downgraded refuses with 409 path-off", async () => {
    const cov = new FakeCoverage();
    cov.take = () => {
      cov.state = "error";
      cov.reason = "another inspector session stopped precise coverage; restart the app";
      return undefined;
    };
    const { d } = deps({ cov });
    const err = await refusal(capturePath(d, SOURCE));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: "path-off", state: "error" });
  });
});

describe("capturePath: traces and error codes", () => {
  test("the discarded attempt's trace is stamped as superseded; both are announced", async () => {
    const made: TraceRecord[] = [];
    const st = new FakeStore();
    const updates: string[] = [];
    (st as any).update = (t: TraceRecord) => updates.push(t.id);
    const { d, store } = deps({ st });
    const fire = d.fire;
    let n = 0;
    d.fire = async () => {
      if (++n === 1) store.emit("start", makeTrace([], { id: "tr_foreign", path: "/other" }));
      const r = await fire();
      made.push(r.trace!);
      return r;
    };
    const p = await capturePath(d, SOURCE);
    expect(p.traceId).toBe("tr_new2");
    expect(made[0]!.pathTrace).toEqual({ quality: "contaminated", replayOf: "tr_src", supersededBy: "tr_new2" });
    expect(made[1]!.pathTrace).toEqual({ quality: "exact", replayOf: "tr_src" });
    expect(updates.sort()).toEqual(["tr_new1", "tr_new2"]);
  });

  test("summaries carry pathTrace", () => {
    const t = makeTrace([], { id: "a", pathTrace: { quality: "exact", replayOf: "b" } });
    expect(summarize(t).pathTrace).toEqual({ quality: "exact", replayOf: "b" });
  });

  test("every refusal has a stable code and an actionable sentence", async () => {
    const codes: string[] = [];
    const grab = async (p: Promise<unknown>) => {
      const e = await refusal(p);
      expect(e.body.error).toMatch(/ /);
      codes.push(String(e.body.code));
    };
    await grab(capturePath(deps().d, makeTrace([], { method: "POST" })));
    await grab(capturePath(deps({ coverage: undefined }).d, SOURCE));
    await grab(capturePath(deps({ busy: () => "a Replay xN batch is running" }).d, SOURCE));
    await grab(capturePath(deps({ fire: async () => ({ status: 0, error: "Could not reach your app" }) }).d, SOURCE));
    const cov = new FakeCoverage();
    cov.take = () => undefined;
    await grab(capturePath(deps({ cov }).d, SOURCE));
    expect(codes).toEqual(["method", "path-off", "not-quiet", "replay-failed", "take-failed"]);
  });
});

describe("api/path", () => {
  const fakeRes = () => {
    const out: { status?: number; body?: any } = {};
    return {
      out,
      res: {
        writeHead: (s: number) => {
          out.status = s;
        },
        end: (b: string) => {
          out.body = JSON.parse(b);
        },
      } as any,
    };
  };
  const readEp = pathApi.endpoints.find((e) => e.method === "GET")!;

  test("GET path of a path trace whose payload rotated out is 410 evicted; never had one is 404", async () => {
    const store = new TraceStore(10);
    const old = makeTrace([], { id: "tr_old", pathTrace: { quality: "exact", replayOf: "tr_src" } });
    const plain = makeTrace([], { id: "tr_plain" });
    store.add(old, { rawHeaders: {} });
    store.add(plain, { rawHeaders: {} });
    const rt = { store } as any;
    const a = fakeRes();
    await readEp.handle({} as any, a.res, rt, { params: { id: "tr_old" } } as any);
    expect(a.out).toMatchObject({ status: 410, body: { code: "evicted" } });
    expect(a.out.body.error).toMatch(/tr_src/);
    const b = fakeRes();
    await readEp.handle({} as any, b.res, rt, { params: { id: "tr_plain" } } as any);
    expect(b.out).toMatchObject({ status: 404, body: { code: "no-path" } });
  });

  test("the replay has a deadline: a GET that never answers ends the fire with an error", async () => {
    const server = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as any).port;
      const store = new TraceStore(10);
      const rt = { store, appPort: port, options: {}, root: ROOT } as any;
      const t0 = Date.now();
      const r = await captureDeps(rt, makeTrace([], { id: "s", url: "/hang" }), 150).fire();
      expect(r.error).toMatch(/time limit/);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("P2 capture fields: errors and staleness", () => {
  const read = (abs: string) => FILES[abs];

  test("stackLines reads mapped frames of one file", () => {
    const stack = [
      "Error: not found",
      "    at find (src/s.js:2:9)",
      "    at async <anonymous> (src/r.js:3:10)",
      "    at src/r.js:4:1",
      "    at Layer.handle (express/lib/router/layer.js:95:5)  [framework]",
    ].join("\n");
    expect(stackLines(stack, "src/r.js")).toEqual([3, 4]);
    expect(stackLines(stack, "src/s.js")).toEqual([2]);
    expect(stackLines(stack, "src/x.js")).toEqual([]);
  });

  test("a hop that threw: its count, and per distinct error the innermost frame inside each function", () => {
    const t = replayTrace("tr_e");
    const handler = t.spans.find((x) => x.kind === "handler")!;
    const find = t.spans.find((x) => x.kind === "function")!;
    const stack = "Error: gone\n    at find (src/s.js:2:9)\n    at async <anonymous> (src/r.js:3:10)";
    find.error = { type: "Error", message: "gone", stack };
    // The same error recorded on the handler's hop too (it passed through): counted once.
    handler.error = { type: "Error", message: "gone", stack };
    const b = buildPayload(t, scripts(), ROOT, read);
    expect(b.functions["src/s.js:1:find"]!.errors).toEqual({ hops: 1, lines: [2] });
    expect(b.functions["src/r.js:2:GET /x/:id"]!.errors).toEqual({ hops: 1, lines: [3] });
    // No error anywhere: no field.
    expect(
      buildPayload(replayTrace("tr_ok"), scripts(), ROOT, read).functions["src/s.js:1:find"]!.errors,
    ).toBeUndefined();
  });

  test("a file modified after the process started is stale", () => {
    const t = replayTrace("tr_s");
    const start = 1_000_000;
    const fresh = buildPayload(t, scripts(), ROOT, read, { mtime: () => start - 5000, processStart: start });
    expect(fresh.functions["src/s.js:1:find"]!.stale).toBeUndefined();
    const edited = buildPayload(t, scripts(), ROOT, read, { mtime: () => start + 60_000, processStart: start });
    expect(edited.functions["src/s.js:1:find"]!.stale).toBe(true);
  });

  test("GET builds the analysis once, lazily, and caches it on the stored payload", async () => {
    const { d } = deps();
    const p = await capturePath(d, SOURCE);
    expect(p.analysis).toBeUndefined();
    const store = new TraceStore(10);
    pathApi.analyzed({ store, root: ROOT, pathAnalyzer: undefined } as any, p);
    // No analyzer: function-level truth stays, decisions are unknown with the reason.
    expect(p.functions["src/s.js:1:find"]!.analysis).toMatchObject({ status: "unknown", why: "no-analyzer" });
    const first = p.analysis;
    expect(first?.text).toBe("Exit: UNKNOWN (no-analyzer)");
    pathApi.analyzed({ store, root: ROOT, pathAnalyzer: { cfg: () => undefined } } as any, p);
    expect(p.analysis).toBe(first);
  });
});
