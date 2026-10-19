import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/api/client";
import type { Discovery, Meta, TraceSummary } from "../src/api/types";
import {
  actionError,
  frameworkCopy,
  infoNote,
  metaState,
  resyncTraces,
  routesState,
  selectedTrace,
  selectedTraceId,
  tracesState,
} from "../src/state/store";

/*
 * After the live stream reconnects, the server may have restarted (next dev restarts its server
 * process) and lost every trace. The list must follow the server, not keep rows that now 404.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/resync.test.ts
 */

const row = (id: string) => ({ id, path: "/api/x", method: "GET", done: true, kind: "route" }) as TraceSummary;

beforeEach(() => {
  vi.spyOn(api, "meta").mockRejectedValue(new Error("not mocked"));
  vi.spyOn(api, "routes").mockRejectedValue(new Error("not mocked"));
});

afterEach(() => {
  vi.restoreAllMocks();
  tracesState.value = [];
  selectedTraceId.value = null;
  selectedTrace.value = null;
  actionError.value = null;
  infoNote.value = null;
  metaState.value = null;
  routesState.value = null;
});

const meta = (framework?: Meta["framework"]) =>
  ({ root: "/", basePath: "", otel: "own", configured: true, autoTrace: true, profiles: {}, framework }) as Meta;
const routes = (...paths: string[]) =>
  ({
    routes: paths.map((p) => ({ id: p, router: "express", path: p, nextRoute: p, file: "", params: [], methods: [] })),
    typescript: false,
    scannedAt: 0,
  }) as Discovery;

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

  test("refetches meta and routes along with the traces", async () => {
    metaState.value = meta({ name: "express", version: "5.1.0" });
    routesState.value = routes("/old");
    vi.spyOn(api, "traces").mockResolvedValue([]);
    const metaSpy = vi.spyOn(api, "meta").mockResolvedValue(meta({ name: "express", version: "5.3.0" }));
    const routesSpy = vi.spyOn(api, "routes").mockResolvedValue(routes("/old", "/new"));
    await resyncTraces();
    expect(metaSpy).toHaveBeenCalledOnce();
    expect(routesSpy).toHaveBeenCalledOnce();
    expect(metaState.value?.framework?.version).toBe("5.3.0");
    expect(routesState.value?.routes.map((r) => r.path)).toEqual(["/old", "/new"]);
  });

  test("meta or routes failing keeps the old ones; the traces still resync", async () => {
    metaState.value = meta({ name: "express" });
    routesState.value = routes("/old");
    tracesState.value = [row("a")];
    vi.spyOn(api, "traces").mockResolvedValue([row("b")]);
    vi.spyOn(api, "meta").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "routes").mockRejectedValue(new Error("boom"));
    await resyncTraces();
    expect(metaState.value?.framework?.name).toBe("express");
    expect(routesState.value?.routes.map((r) => r.path)).toEqual(["/old"]);
    expect(tracesState.value.map((t) => t.id)).toEqual(["b"]);
  });

  test("outside Next a restart is an info note, not an error", async () => {
    tracesState.value = [row("old1")];
    vi.spyOn(api, "traces").mockResolvedValue([]);
    vi.spyOn(api, "meta").mockResolvedValue(meta({ name: "express", version: "5.3.0" }));
    vi.spyOn(api, "routes").mockResolvedValue(routes("/x"));
    await resyncTraces();
    expect(frameworkCopy.value.isNext).toBe(false);
    expect(actionError.value).toBeNull();
    expect(infoNote.value).toMatch(/^App restarted: 1 older request is no longer available/);

    // The next reconnect that lost nothing clears it.
    tracesState.value = [row("n")];
    vi.spyOn(api, "traces").mockResolvedValue([row("n")]);
    await resyncTraces();
    expect(infoNote.value).toBeNull();
  });

  test("a restart that applied a pending path switch says what changed and what to do next", async () => {
    const withPath = (path: Meta["path"]) => ({ ...meta({ name: "express", version: "5.3.0" }), path }) as Meta;
    tracesState.value = [row("old1")];
    metaState.value = withPath({ state: "off", source: "default", pending: "on" } as Meta["path"]);
    vi.spyOn(api, "traces").mockResolvedValue([]);
    vi.spyOn(api, "meta").mockResolvedValue(withPath({ state: "on", source: "flag" } as Meta["path"]));
    await resyncTraces();
    // The open request is gone after a restart: point at a new one rather than leave the user waiting.
    expect(infoNote.value).toMatch(/Request path is now on/);
    expect(infoNote.value).toMatch(/open a new request/i);

    tracesState.value = [];
    metaState.value = withPath({ state: "on", source: "flag", pending: "off" } as Meta["path"]);
    vi.spyOn(api, "meta").mockResolvedValue(withPath({ state: "off", source: "default" } as Meta["path"]));
    await resyncTraces();
    expect(infoNote.value).toMatch(/Request path is now off/);
  });

  test("rows that arrive live while meta/routes are fetched are kept, not counted as lost", async () => {
    tracesState.value = [row("a")];
    let finishRoutes!: (d: Discovery) => void;
    vi.spyOn(api, "traces").mockResolvedValue([row("a")]);
    vi.spyOn(api, "meta").mockResolvedValue(meta({ name: "next", version: "16.0.1" }));
    vi.spyOn(api, "routes").mockReturnValue(
      new Promise<Discovery>((r) => {
        finishRoutes = r;
      }),
    );
    const p = resyncTraces();
    await new Promise((r) => setTimeout(r, 0));
    // An SSE start lands during the (slow) routes scan.
    tracesState.value = [row("live"), ...tracesState.value];
    finishRoutes(routes("/x"));
    await p;
    expect(tracesState.value.map((t) => t.id)).toEqual(["live", "a"]);
    expect(actionError.value).toBeNull();
    expect(infoNote.value).toBeNull();
  });

  test("under Next a lost list stays an error line", async () => {
    tracesState.value = [row("old1")];
    vi.spyOn(api, "traces").mockResolvedValue([]);
    vi.spyOn(api, "meta").mockResolvedValue(meta({ name: "next", version: "16.0.1" }));
    vi.spyOn(api, "routes").mockResolvedValue(routes());
    await resyncTraces();
    expect(actionError.value).toMatch(/^Hoplens restarted: 1 older request is no longer available/);
    expect(infoNote.value).toBeNull();
  });
});
