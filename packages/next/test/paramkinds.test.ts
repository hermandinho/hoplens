import path from "node:path";
import { describe, expect, test } from "vitest";
import { NextDiscoverySource } from "../src/routes";

const root = path.join(__dirname, "fixture-paramkinds");

describe("route path parsing", () => {
  const d = new NextDiscoverySource(root, "").scan();
  const paths = d.routes.map((r) => r.path).sort();

  test("covers every param kind without surprises", () => {
    expect(paths).toEqual([
      "/api/:id",
      "/api/:id",
      "/api/:slug*",
      "/api/:slug+",
      "/api/basic",
      "/api/nested/deep/x/:a/:b",
      "/api/reports",
      "/api/simple",
      "/api/slot/page",
    ]);
  });

  test("drops _private branches", () => {
    expect(paths.some((p) => p.split("/").includes("_private"))).toBe(false);
  });

  test("drops @slot segments but keeps surrounding path", () => {
    expect(paths).toContain("/api/slot/page");
    expect(paths.some((p) => p.includes("@sidebar"))).toBe(false);
  });

  test("drops (groups) but keeps the remaining path", () => {
    expect(paths).toContain("/api/reports");
    expect(paths.some((p) => p.includes("(admin)"))).toBe(false);
  });

  test("catch-all :slug+ and optional catch-all :slug*", () => {
    const catchAll = d.routes.find((r) => r.nextRoute === "/api/[...slug]");
    expect(catchAll?.params).toEqual([{ name: "slug", catchAll: true, optional: false }]);
    const optional = d.routes.find((r) => r.nextRoute === "/api/[[...slug]]");
    expect(optional?.params).toEqual([{ name: "slug", catchAll: true, optional: true }]);
  });

  test("basePath prepends every route", () => {
    const withBase = new NextDiscoverySource(root, "/app").scan();
    expect(withBase.routes.every((r) => r.path.startsWith("/app"))).toBe(true);
  });
});

describe("pages router", () => {
  const d = new NextDiscoverySource(root, "").scan();
  const basic = d.routes.find((r) => r.nextRoute === "/api/basic")!;

  test("pages API default export is detected as ANY", () => {
    expect(basic).toBeDefined();
    expect(basic.router).toBe("pages");
    expect(basic.methods[0]!.method).toBe("ANY");
  });

  test("pages dynamic segment", () => {
    const dyn = d.routes.find((r) => r.router === "pages" && r.params.some((p) => p.name === "id"))!;
    expect(dyn).toBeDefined();
    expect(dyn.path).toBe("/api/:id");
  });
});
