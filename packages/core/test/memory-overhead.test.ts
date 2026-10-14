import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";
import { TraceStore } from "../src/store";
import type { TraceRecord } from "../src/types";

function fakeTrace(id: string): TraceRecord {
  return {
    id,
    startedAt: Date.now(),
    done: false,
    method: "GET",
    url: "/x",
    path: "/x",
    kind: "route",
    request: { headers: {} },
    response: { headers: {} },
    spans: [],
    logs: [],
  };
}

describe("TraceStore memory bound", () => {
  test("ring buffer trims to maxTraces after 10 000 inserts", () => {
    const store = new TraceStore(300);
    for (let i = 0; i < 10_000; i++) store.add(fakeTrace(`t${i}`), { rawHeaders: {} });
    expect(store.list().length).toBe(300);
    // The 300 most recent survive.
    expect(store.get("t9999")).toBeDefined();
    expect(store.get("t9700")).toBeDefined();
    expect(store.get("t9699")).toBeUndefined();
    expect(store.get("t0")).toBeUndefined();
  });

  test("10 000 inserts stay within a reasonable heap delta", () => {
    const store = new TraceStore(300);
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10_000; i++) store.add(fakeTrace(`t${i}`), { rawHeaders: {} });
    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    const delta = after - before;
    // Only 300 records retained; delta should stay comfortably below 10 MB
    // on any realistic Node heap for this payload size.
    expect(delta, `heap grew by ${(delta / 1024 / 1024).toFixed(2)} MB`).toBeLessThan(10 * 1024 * 1024);
  });

  test("clear() releases every retained record", () => {
    const store = new TraceStore(1000);
    for (let i = 0; i < 500; i++) store.add(fakeTrace(`t${i}`), { rawHeaders: {} });
    expect(store.list().length).toBe(500);
    store.clear();
    expect(store.list().length).toBe(0);
    expect(store.get("t0")).toBeUndefined();
  });

  test("events fire for start / done / clear in order", () => {
    const store = new TraceStore(10);
    const seen: string[] = [];
    store.on("start", (t) => seen.push(`start:${t.id}`));
    store.on("done", (t) => seen.push(`done:${t.id}`));
    store.on("clear", () => seen.push("clear"));

    const a = fakeTrace("a");
    store.add(a, { rawHeaders: {} });
    store.finish(a);
    store.clear();

    expect(seen).toEqual(["start:a", "done:a", "clear"]);
  });
});

describe("overhead budget", () => {
  test("TraceStore.add stays well under 1ms per insert at 10k inserts", () => {
    const store = new TraceStore(500);
    const traces = Array.from({ length: 10_000 }, (_, i) => fakeTrace(`t${i}`));
    const t0 = performance.now();
    for (const t of traces) store.add(t, { rawHeaders: {} });
    const elapsed = performance.now() - t0;
    const perInsert = elapsed / traces.length;
    // Well under the 2ms/request runtime budget; this is just the store cost.
    expect(perInsert, `${perInsert.toFixed(3)} ms per insert`).toBeLessThan(0.1);
  });

  test("preview on a modestly-shaped request body is sub-millisecond on average", async () => {
    const { makeRedactor, preview } = await import("../src/serialize");
    const r = makeRedactor(["password", "token"]);
    const payload = {
      user: { id: 42, name: "Amina", email: "amina@example.com", password: "hunter22" },
      items: Array.from({ length: 20 }, (_, i) => ({ sku: `s${i}`, qty: i, token: `tok_${i}` })),
      meta: { timestamp: Date.now(), source: "test" },
    };

    const N = 2_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) preview(payload, r);
    const elapsed = performance.now() - t0;
    const perCall = elapsed / N;
    expect(perCall, `${perCall.toFixed(3)} ms per preview`).toBeLessThan(1);
  });
});
