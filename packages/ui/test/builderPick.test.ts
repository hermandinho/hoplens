import { describe, expect, test, vi } from "vitest";
import type { RouteInfo } from "../src/api/types";
import { routeKeyFor } from "../src/state/store";

/*
 * "New request" from a trace preselects the route it hit. Express lists one template once per
 * registration file (GET /x in a.js, POST /x in b.js), so the match spans every entry of the template.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/builderPick.test.ts
 */

const info = (id: string, nextRoute: string, methods: string[]): RouteInfo =>
  ({
    id,
    router: "express",
    path: nextRoute,
    nextRoute,
    file: "",
    params: [],
    methods: methods.map((method) => ({ method, line: 1, schemas: [], readsBody: false })),
  }) as unknown as RouteInfo;

describe("routeKeyFor", () => {
  const routes = [
    info("express /x", "/x", ["GET"]),
    info("express /x (b.js)", "/x", ["POST"]),
    info("express /any", "/any", ["ANY"]),
  ];

  test("finds the method on a later entry of the same template", () => {
    expect(routeKeyFor(routes, "POST", "/x")).toBe("express /x (b.js)::POST");
    expect(routeKeyFor(routes, "GET", "/x")).toBe("express /x::GET");
  });

  test("never preselects a regex route (listed, but not sendable)", () => {
    const re = info("express /^\\/re$/", "/^\\/re$/", ["GET"]);
    expect(routeKeyFor([re], "GET", "/^\\/re$/")).toBeUndefined();
  });

  test("falls back to ANY, and to nothing when no entry answers the method", () => {
    expect(routeKeyFor(routes, "PUT", "/any")).toBe("express /any::ANY");
    expect(routeKeyFor(routes, "PUT", "/x")).toBeUndefined();
    expect(routeKeyFor(routes, "GET", "/nope")).toBeUndefined();
  });
});

describe("a regex route in the builder", () => {
  test("Send refuses it with the picker's reason instead of sending the regex as a URL", async () => {
    const { api } = await import("../src/api/client");
    const { metaState, routesState, selectedRouteKey } = await import("../src/state/store");
    const { builderState, sendError, sendRequest, unsendableReason } = await import("../src/state/builder");
    const { REGEX_REASON } = await import("../src/state/routePick");
    const re = info("express /^\\/re$/", "/^\\/re$/", ["GET"]);
    metaState.value = { root: "/", basePath: "", profiles: {}, framework: { name: "express" } } as never;
    routesState.value = { routes: [re], typescript: false, scannedAt: 0 } as never;
    selectedRouteKey.value = `${re.id}::GET`;
    const run = vi.spyOn(api, "run").mockResolvedValue({} as never);
    try {
      expect(builderState.value?.path).toBe("/^\\/re$/");
      expect(unsendableReason.value).toBe(REGEX_REASON);
      await sendRequest();
      expect(run).not.toHaveBeenCalled();
      expect(sendError.value).toBe(REGEX_REASON);
    } finally {
      run.mockRestore();
      selectedRouteKey.value = null;
      routesState.value = null;
      metaState.value = null;
      sendError.value = null;
    }
  });
});
