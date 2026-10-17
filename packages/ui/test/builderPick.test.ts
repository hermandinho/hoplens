import { describe, expect, test } from "vitest";
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

  test("falls back to ANY, and to nothing when no entry answers the method", () => {
    expect(routeKeyFor(routes, "PUT", "/any")).toBe("express /any::ANY");
    expect(routeKeyFor(routes, "PUT", "/x")).toBeUndefined();
    expect(routeKeyFor(routes, "GET", "/nope")).toBeUndefined();
  });
});
