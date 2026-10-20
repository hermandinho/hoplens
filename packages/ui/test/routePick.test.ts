import { describe, expect, test } from "vitest";
import type { MethodInfo, RouteInfo } from "../src/api/types";
import {
  REGEX_GROUP,
  isRegexRoute,
  missingParams,
  pathParts,
  pickerGroups,
  resolvePath,
  seedParams,
} from "../src/state/routePick";

/*
 * Request builder rough edges found on Express (M3): params seeded with their own names, the picker
 * showing the builder path, regex routes, an optional param after a `.`, duplicate labels.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/routePick.test.ts
 */

const method = (m: string, over: Partial<MethodInfo> = {}): MethodInfo => ({
  method: m,
  line: 1,
  schemas: [],
  readsBody: false,
  ...over,
});

const route = (over: Partial<RouteInfo> & Pick<RouteInfo, "id" | "path">): RouteInfo => ({
  router: "express",
  nextRoute: over.path,
  file: "",
  params: [],
  methods: [method("GET")],
  ...over,
});

describe("params", () => {
  test("seeded empty (the chip shows the name), never with the name itself; id and examples kept", () => {
    const r = route({
      id: "u",
      path: "/u/:uid/o/:id",
      params: [
        { name: "uid", catchAll: false, optional: false },
        { name: "id", catchAll: false, optional: false },
      ],
    });
    expect(seedParams(r, method("GET"))).toEqual({ uid: "", id: "123" });
    const withExample = method("GET", {
      schemas: [{ target: "params", example: { uid: "u_1" }, fields: [] } as unknown as MethodInfo["schemas"][number]],
    });
    expect(seedParams(r, withExample)).toEqual({ uid: "u_1", id: "123" });
  });

  test("an empty required param is reported missing and left as :name", () => {
    expect(missingParams("/u/:uid/:rest*", { uid: "" })).toEqual(["uid"]);
    expect(missingParams("/u/:uid/:rest*", { uid: "7" })).toEqual([]);
    expect(resolvePath("/u/:uid", {})).toBe("/u/:uid");
    expect(resolvePath("/u/:uid", { uid: "7" })).toBe("/u/7");
  });

  test("an empty optional param drops the '.' that introduced it", () => {
    expect(resolvePath("/report.:format*", { format: "" })).toBe("/report");
    expect(resolvePath("/report.:format*", { format: "csv" })).toBe("/report.csv");
    expect(resolvePath("/a-:b*/c", {})).toBe("/a/c");
    expect(resolvePath("/files/:rest*", {})).toBe("/files");
    expect(resolvePath("/files/:rest+", { rest: "a/b" })).toBe("/files/a/b");
  });

  test("an empty optional param that is a whole segment drops its '/' (no '//' mid-path)", () => {
    expect(resolvePath("/a/:b*/c", {})).toBe("/a/c");
    expect(resolvePath("/a/:b*/c", { b: "x" })).toBe("/a/x/c");
    expect(resolvePath("/x/:a*/b/:c*", {})).toBe("/x/b");
    expect(resolvePath("/:rest*", {})).toBe("/");
    // Mid-segment ones keep the '/' and drop only their own introducer.
    expect(resolvePath("/a/v-:n*/c", {})).toBe("/a/v/c");
  });

  test("an empty one-or-more (+) param is required", () => {
    expect(missingParams("/files/:splat+", { splat: "" })).toEqual(["splat"]);
    expect(missingParams("/files/:splat+", { splat: "a/b" })).toEqual([]);
    expect(missingParams("/files/:splat*", {})).toEqual([]);
  });

  test("pathParts splits mid-segment params into chips", () => {
    expect(pathParts("/u/:uid/report.:format*")).toEqual([
      { kind: "sep" },
      { kind: "text", text: "u" },
      { kind: "sep" },
      { kind: "param", name: "uid", mod: "" },
      { kind: "sep" },
      { kind: "text", text: "report." },
      { kind: "param", name: "format", mod: "*" },
    ]);
  });
});

describe("pickerGroups", () => {
  test("labels show the trace template outside Next; Next keeps its :param path", () => {
    const express = route({ id: "e", path: "/report", nextRoute: "/report(.:format)?" });
    expect(pickerGroups([express], false)[0]?.options[0]?.label).toBe("GET /report(.:format)?");
    const next = route({ id: "app/api/x/[id]/route.ts", router: "app", path: "/api/x/:id", nextRoute: "/api/x/[id]" });
    const g = pickerGroups([next], true);
    expect(g[0]?.label).toBe("/api");
    expect(g[0]?.options[0]).toEqual({ value: "app/api/x/[id]/route.ts::GET", label: "GET /api/x/:id" });
  });

  test("regex routes are listed last, disabled with a reason, not under a '/^\\' group", () => {
    const re = route({ id: "express /^\\/legacy$/i", path: "/^\\/legacy$/i" });
    expect(isRegexRoute(re)).toBe(true);
    expect(
      isRegexRoute(route({ id: "a", path: "/a/:id", params: [{ name: "id", catchAll: false, optional: false }] })),
    ).toBe(false);
    const groups = pickerGroups([re, route({ id: "a", path: "/a" })], false);
    expect(groups.map((g) => g.label)).toEqual(["/a", REGEX_GROUP]);
    const opt = groups[1]?.options[0];
    expect(opt?.disabled).toBe(true);
    expect(opt?.reason).toMatch(/regex/);
  });

  test("one template + method registered in two files: the file tells them apart", () => {
    const a = route({ id: "express /x", path: "/x", file: "src/a.js" });
    const b = route({ id: "express /x (src/b.js)", path: "/x", file: "src/b.js" });
    const c = route({ id: "express /x (src/c.js)", path: "/x", file: "src/c.js", methods: [method("POST")] });
    const labels = pickerGroups([a, b, c], false)[0]?.options.map((o) => o.label);
    expect(labels).toEqual(["GET /x  (src/a.js)", "GET /x  (src/b.js)", "POST /x"]);
  });

  test("the root route groups under /root, as before", () => {
    expect(pickerGroups([route({ id: "r", path: "/" })], false)[0]?.label).toBe("/root");
  });
});
