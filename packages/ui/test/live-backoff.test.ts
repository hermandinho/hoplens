import { afterEach, describe, expect, test, vi } from "vitest";
import { openLive } from "../src/api/client";

/*
 * The live stream's reconnect backoff, and its cap while a request path toggle waits for the
 * restart (meta.path.pending): the open tab must notice the restart within a couple of seconds.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/live-backoff.test.ts
 */

class FakeSource {
  static made = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSource.made++;
  }
  addEventListener() {}
  close() {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSource.made = 0;
});

/** Fail `n` connects in a row; returns the delay before each retry. */
function delays(n: number, opts?: Parameters<typeof openLive>[2]): number[] {
  vi.useFakeTimers();
  const sources: FakeSource[] = [];
  vi.stubGlobal(
    "EventSource",
    class extends FakeSource {
      constructor() {
        super();
        sources.push(this);
      }
    },
  );
  const conn = openLive(() => {}, undefined, opts);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const before = Date.now();
    sources[sources.length - 1].onerror?.();
    const count = sources.length;
    while (sources.length === count) vi.advanceTimersByTime(250);
    out.push(Date.now() - before);
  }
  conn.close();
  return out;
}

describe("openLive backoff", () => {
  test("doubles to 30 s by default", () => {
    expect(delays(7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test("maxDelay caps it (while a path toggle is pending)", () => {
    expect(delays(5, { maxDelay: () => 1500 })).toEqual([1000, 1500, 1500, 1500, 1500]);
  });
});
