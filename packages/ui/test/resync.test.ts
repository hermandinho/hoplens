import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/api/client";
import type { TraceSummary } from "../src/api/types";
import { actionError, resyncTraces, selectedTrace, selectedTraceId, tracesState } from "../src/state/store";

/*
 * After the live stream reconnects, the server may have restarted (next dev restarts its server
 * process) and lost every trace. The list must follow the server, not keep rows that now 404.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/resync.test.ts
 */

const row = (id: string) => ({ id, path: "/api/x", method: "GET", done: true, kind: "route" }) as TraceSummary;

afterEach(() => {
  vi.restoreAllMocks();
  tracesState.value = [];
  selectedTraceId.value = null;
  selectedTrace.value = null;
  actionError.value = null;
});

describe("resyncTraces", () => {
  test("drops rows the server no longer has and closes an open one that is gone", async () => {
    tracesState.value = [row("old1"), row("old2")];
    selectedTraceId.value = "old1";
    vi.spyOn(api, "traces").mockResolvedValue([row("new1")]);
    await resyncTraces();
    expect(tracesState.value.map((t) => t.id)).toEqual(["new1"]);
    expect(selectedTraceId.value).toBeNull();
    expect(actionError.value).toMatch(/2 older requests are no longer available/);
  });

  test("a plain reconnect with nothing lost keeps the selection and says nothing", async () => {
    tracesState.value = [row("a")];
    selectedTraceId.value = "a";
    vi.spyOn(api, "traces").mockResolvedValue([row("b"), row("a")]);
    await resyncTraces();
    expect(tracesState.value.map((t) => t.id)).toEqual(["b", "a"]);
    expect(selectedTraceId.value).toBe("a");
    expect(actionError.value).toBeNull();
  });

  test("server still unreachable: local state is left alone", async () => {
    tracesState.value = [row("a")];
    vi.spyOn(api, "traces").mockRejectedValue(new Error("offline"));
    await resyncTraces();
    expect(tracesState.value.map((t) => t.id)).toEqual(["a"]);
  });
});
