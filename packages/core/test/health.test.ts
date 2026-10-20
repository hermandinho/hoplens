// WP6 health: event-loop delay, process-error capture that never changes process behavior, the
// /api/health endpoints and the throttled SSE feed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { IntervalHistogram } from "node:perf_hooks";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { attachHealthEvents } from "../src/api/health";
import { HealthMonitor, loopFloorMs } from "../src/health";
import type { Runtime } from "../src/runtime";
import { handleUi } from "../src/server";
import { TraceStore } from "../src/store";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nsToMs = (ns: number) => ns / 1e6;
function block(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait: the loop is blocked
  }
}

const monitors: HealthMonitor[] = [];
function monitor(opts: ConstructorParameters<typeof HealthMonitor>[0] = {}) {
  const h = new HealthMonitor({ enabled: true, ...opts });
  monitors.push(h);
  return h;
}
afterEach(() => {
  for (const h of monitors.splice(0)) h.stop();
});

describe("HealthMonitor", () => {
  test("a 100ms block shows loop p99 of the block minus the timer interval", async () => {
    const h = monitor({ resolutionMs: 10, sampleMs: 60_000 }).start();
    await wait(30);
    block(100);
    await wait(30);
    const s = h.sample();
    // The timer was due up to one interval into the block, so its lateness is the block minus the
    // largest floor sample() can subtract: 11ms on Linux, 16.6ms on Windows (15.6ms tick). 2ms slack
    // for Date.now() granularity in block().
    const min = 98 - loopFloorMs(undefined, Number.POSITIVE_INFINITY, 10);
    expect(s.loopP99).toBeGreaterThanOrEqual(min);
    expect(s.loopMax).toBeGreaterThanOrEqual(min);
    expect(s.rss).toBeGreaterThan(0);
    expect(s.heapUsed).toBeGreaterThan(0);
    // The histogram resets per window: checked on the histogram itself, since how late the next
    // window's timers run depends on machine load (a descheduled process reads 150ms+ anyway).
    const hist = (h as unknown as { histogram: IntervalHistogram }).histogram;
    expect(hist.count).toBe(0);
    expect(hist.max).toBe(0);
  });

  test("the sampler's own timer interval is not reported as loop delay", async () => {
    const h = monitor({ resolutionMs: 20, sampleMs: 60_000 }).start();
    await wait(250);
    // Raw values read ~20ms (Linux) / ~31ms (Windows) on an idle loop: the timer interval itself.
    const raw = nsToMs((h as unknown as { histogram: IntervalHistogram }).histogram.percentile(50));
    const s = h.sample();
    // Calibrated against this window's raw p50 instead of assuming an idle machine. Up to the platform's
    // interval (+1ms) the raw p50 is the sampler's own timer and must read ~0. Lateness beyond that is
    // real delay (on a loaded machine the process waits for a core, and so would the app's timers), and
    // may be reported, but only that excess: the interval is never part of it.
    const excess = Math.max(0, raw - loopFloorMs(undefined, Number.POSITIVE_INFINITY, 20));
    expect(s.loopP50).toBeLessThan(10 + excess);
    if (excess === 0) expect(s.loopP50).toBeLessThan(10);
  });

  test("loopFloorMs: lowest window p50, clamped to [resolution, the platform's timer interval + 1]", () => {
    expect(loopFloorMs(undefined, 31.3, 20, "win32")).toBe(31.3);
    expect(loopFloorMs(31.3, 20.4, 20, "win32")).toBe(20.4);
    expect(loopFloorMs(20.4, 300, 20, "win32")).toBe(20.4);
    expect(loopFloorMs(undefined, 300, 20, "win32")).toBe(32.25);
    expect(loopFloorMs(undefined, 300, 10, "win32")).toBe(16.625);
    expect(loopFloorMs(undefined, 300, 20, "linux")).toBe(21);
    expect(loopFloorMs(undefined, 20.3, 20, "linux")).toBe(20.3);
    expect(loopFloorMs(undefined, 5, 20, "linux")).toBe(20);
  });

  test("keeps a ring of samples", () => {
    const h = monitor({ ring: 3, sampleMs: 60_000 }).start();
    for (let i = 0; i < 5; i++) h.sample();
    const snap = h.snapshot();
    expect(snap.samples).toHaveLength(3);
    expect(snap.current).toBe(snap.samples[2]);
    expect(snap.active).toBe(true);
  });

  test("start attaches, stop removes every process listener", () => {
    const before = {
      mon: process.listenerCount("uncaughtExceptionMonitor"),
      rej: process.listenerCount("unhandledRejection"),
    };
    const h = monitor({ sampleMs: 60_000 }).start();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before.mon + 1);
    h.stop();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before.mon);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rej);
    expect(h.snapshot().active).toBe(false);
  });

  test("disabled (production) attaches nothing", () => {
    const before = process.listenerCount("uncaughtExceptionMonitor");
    const h = monitor({ enabled: false }).start();
    expect(h.active).toBe(false);
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before);
  });

  test("only listens to unhandledRejection while another listener exists", () => {
    // Vitest's own listener may be present; measure relative to it.
    const saved = process.listeners("unhandledRejection");
    for (const l of saved) process.off("unhandledRejection", l);
    try {
      const h = monitor({ sampleMs: 60_000 }).start();
      expect(process.listenerCount("unhandledRejection")).toBe(0);
      expect(h.snapshot().watchingRejections).toBe(false);
      const user = () => {};
      process.on("unhandledRejection", user);
      (h as unknown as { tick(): void }).tick();
      expect(process.listenerCount("unhandledRejection")).toBe(2);
      expect(h.snapshot().watchingRejections).toBe(true);
      process.off("unhandledRejection", user);
      (h as unknown as { tick(): void }).tick();
      expect(process.listenerCount("unhandledRejection")).toBe(0);
    } finally {
      for (const l of saved) process.on("unhandledRejection", l);
    }
  });
});

/* ------------------------------------------------------------ child processes */

let tmp: string;
let healthCjs: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-health-"));
  const src = fs.readFileSync(path.join(__dirname, "../src/health.ts"), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  healthCjs = path.join(tmp, "health.cjs");
  fs.writeFileSync(healthCjs, out.outputText);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Runs `body` in a fresh node with `h` (a started HealthMonitor) in scope; REC lines go to stderr. */
function child(body: string, execArgv: string[] = []) {
  const file = path.join(tmp, `c${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(
    file,
    `const { HealthMonitor } = require(${JSON.stringify(healthCjs)});
const fs = require("node:fs");
const h = new HealthMonitor({ enabled: true, sampleMs: 50 }).start();
h.on("processError", (r) => fs.writeSync(2, "REC " + r.kind + " " + r.message + "\\n"));
${body}`,
  );
  const r = spawnSync(process.execPath, [...execArgv, file], { encoding: "utf8", timeout: 15_000 });
  const recs = r.stderr.split("\n").filter((l) => l.startsWith("REC "));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, recs };
}

describe("process errors keep their default behavior", () => {
  test("a rejection with a user listener is recorded and the process stays alive", () => {
    const r = child(`
process.on("unhandledRejection", () => {});
h.tick();
Promise.reject(new Error("nope"));
setTimeout(() => { fs.writeSync(1, "ALIVE " + h.snapshot().errorCounts.unhandledRejection); process.exit(0); }, 150);
`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ALIVE 1");
    expect(r.recs).toEqual(["REC unhandledRejection nope"]);
  });

  test("an uncaught exception still crashes, and is recorded", () => {
    const r = child(`setTimeout(() => { throw new Error("crash"); }, 10);
setTimeout(() => fs.writeSync(1, "SURVIVED"), 500);`);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("SURVIVED");
    expect(r.stderr).toContain("Error: crash");
    expect(r.recs).toEqual(["REC uncaughtException crash"]);
  });

  test("an unhandled rejection with no other listener still crashes, recorded once", () => {
    const r = child(`Promise.reject(new Error("rej"));
setTimeout(() => fs.writeSync(1, "SURVIVED"), 500);`);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("SURVIVED");
    expect(r.recs).toEqual(["REC unhandledRejection rej"]);
  });

  test("a listener removed between ticks: the rejection still crashes", () => {
    const r = child(`
const user = () => {};
process.on("unhandledRejection", user);
h.tick();
process.off("unhandledRejection", user);
Promise.reject(new Error("late"));
setTimeout(() => fs.writeSync(1, "SURVIVED"), 500);
`);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("SURVIVED");
    expect(r.stderr).toContain("late");
    expect(r.recs).toEqual(["REC unhandledRejection late"]);
  });

  test("a user uncaughtException handler still keeps the process alive", () => {
    const r = child(`
process.on("uncaughtException", () => {});
setTimeout(() => { throw new Error("handled"); }, 10);
setTimeout(() => { fs.writeSync(1, "ALIVE"); process.exit(0); }, 150);
`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ALIVE");
    expect(r.recs).toEqual(["REC uncaughtException handled"]);
  });

  test("--unhandled-rejections=none: no listener of ours, so the process still lives", () => {
    const r = child(
      `Promise.reject(new Error("quiet"));
setTimeout(() => { fs.writeSync(1, "ALIVE"); process.exit(0); }, 150);`,
      ["--unhandled-rejections=none"],
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ALIVE");
  });

  test("the unref'd sampler alone does not keep the process alive", () => {
    const r = child(`fs.writeSync(1, "DONE");`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("DONE");
  });
});

/* ------------------------------------------------------------------ SSE feed */

describe("attachHealthEvents", () => {
  // Fake timers (Date included): the throttle is pure timer + clock logic, and on a loaded machine a
  // real `wait(150)` can resolve well past the gap, so a later emit is legitimately sent at once.
  afterEach(() => {
    vi.useRealTimers();
  });

  test("throttles to one event per gap, creates no timer until needed, clears it on detach", () => {
    vi.useFakeTimers();
    const h = monitor({ sampleMs: 60_000 });
    const chunks: string[] = [];
    const detach = attachHealthEvents(h, (c) => chunks.push(c), 100);
    expect(vi.getTimerCount()).toBe(0);
    h.sample();
    h.emit("sample");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/^event: health\ndata: /);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10);
    h.emit("sample");
    h.emit("sample");
    expect(chunks).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    // Sent exactly one gap after the previous event, not one gap after the emit.
    vi.advanceTimersByTime(89);
    expect(chunks).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(chunks).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    // A pending send is dropped on detach.
    vi.advanceTimersByTime(50);
    h.emit("sample");
    expect(chunks).toHaveLength(2);
    detach();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(chunks).toHaveLength(2);
    expect(h.listenerCount("sample")).toBe(0);
    expect(h.listenerCount("processError")).toBe(0);
  });

  test("immediate: the first event counts toward the gap, so the next tick waits", () => {
    vi.useFakeTimers();
    const h = monitor({ sampleMs: 60_000 });
    const chunks: string[] = [];
    const detach = attachHealthEvents(h, (c) => chunks.push(c), 100, { immediate: true });
    expect(chunks).toHaveLength(1);
    h.sample();
    h.emit("sample");
    expect(chunks).toHaveLength(1);
    vi.advanceTimersByTime(99);
    expect(chunks).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(chunks).toHaveLength(2);
    detach();
  });

  test("carries process errors recorded since the previous event", () => {
    const h = monitor({ sampleMs: 60_000 });
    const chunks: string[] = [];
    const detach = attachHealthEvents(h, (c) => chunks.push(c), 0);
    (h as unknown as { record(k: string, e: unknown): void }).record("unhandledRejection", new Error("x"));
    const tick = JSON.parse(chunks[0]!.split("data: ")[1]!);
    expect(tick.newErrors).toHaveLength(1);
    expect(tick.newErrors[0]).toMatchObject({ kind: "unhandledRejection", message: "x" });
    expect(tick.errorCounts.unhandledRejection).toBe(1);
    h.emit("sample");
    expect(JSON.parse(chunks[1]!.split("data: ")[1]!).newErrors).toHaveLength(0);
    detach();
  });
});

describe("GET /api/health and /api/health/stream", () => {
  const health = new HealthMonitor({ enabled: true, sampleMs: 100 });
  const rt = { options: {}, health, store: new TraceStore(10) } as unknown as Runtime;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    health.start();
    health.sample();
    server = http.createServer((req, res) => {
      handleUi(rt, req, res).catch(() => res.end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__hoplens`;
  });
  afterAll(async () => {
    health.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("snapshot", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as any;
    expect(body.active).toBe(true);
    expect(body.current.rss).toBeGreaterThan(0);
    expect(body.samples.length).toBeGreaterThanOrEqual(1);
    expect(body.errorCounts).toEqual({ uncaughtException: 0, unhandledRejection: 0 });
  });

  test("stream sends an immediate event, then sampler ticks, and unsubscribes on close", async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/health/stream`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while ((text.match(/event: health/g) ?? []).length < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect((text.match(/event: health/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(health.listenerCount("sample")).toBe(1);
    ac.abort();
    await reader.cancel().catch(() => {});
    const until = Date.now() + 2000;
    while (health.listenerCount("sample") > 0 && Date.now() < until) await wait(20);
    expect(health.listenerCount("sample")).toBe(0);
  });

  test("the main /api/events stream carries health ticks too, and detaches on close", async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (!/event: health\ndata: .*\n\n/.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain("event: hello");
    const data = /event: health\ndata: (.*)\n\n/.exec(text)?.[1];
    expect(data).toBeDefined();
    const tick = JSON.parse(data!);
    expect(tick.current.rss).toBeGreaterThan(0);
    expect(tick.errorCounts).toEqual({ uncaughtException: 0, unhandledRejection: 0 });
    expect(health.listenerCount("processError")).toBe(1);
    ac.abort();
    await reader.cancel().catch(() => {});
    const until = Date.now() + 2000;
    while (health.listenerCount("processError") > 0 && Date.now() < until) await wait(20);
    expect(health.listenerCount("processError")).toBe(0);
  });
});
