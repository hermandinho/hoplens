import { afterEach, describe, expect, test, vi } from "vitest";
import { calleeOfTitle, culpritLoc, findCallLine } from "../src/state/callSite";

/* R2: one culprit line for an N+1 everywhere (Overview, route subject, palette, trace verdict). */

describe("N+1 call site", () => {
  test("the per-item function comes from the title's 'via fn()'", () => {
    expect(calleeOfTitle("buildFeedSlow fetched GET /users/:id x10 via getUser() (N+1)")).toBe("getUser");
    expect(calleeOfTitle("route handler ran SELECT x12 (N+1)")).toBeUndefined();
  });

  test("the loop line is the first call below the declaration, not the declaration", () => {
    const src = {
      start: 63,
      lines: [
        "export async function buildFeedSlow(posts) {",
        "  const out = [];",
        "  for (const p of posts) {",
        "    // getUserName is not the call",
        "    const author = await getUser(p.userId);",
        "    out.push({ ...p, author });",
      ],
    };
    expect(findCallLine(src, 63, "getUser")).toBe(67);
    expect(findCallLine(src, 63, "missing")).toBeUndefined();
    // Only at or after the declaration line.
    expect(findCallLine(src, 68, "getUser")).toBeUndefined();
  });

  describe("a core-captured call site (location.via, r4)", () => {
    afterEach(() => vi.unstubAllGlobals());
    const title = "buildFeedSlow fetched GET /users/:id x10 via getUser() (N+1)";

    test("is used as is: no source read", () => {
      const fetch = vi.fn(() => Promise.reject(new Error("offline")));
      vi.stubGlobal("fetch", fetch);
      const loc = { file: "src/lib/via.ts", line: 67, via: "call-site" as const };
      expect(culpritLoc({ rule: "n-plus-1", title, location: loc })).toBe(loc);
      expect(fetch).not.toHaveBeenCalled();
    });

    test("an unmarked location (older core) still searches the source", () => {
      const fetch = vi.fn(() => Promise.reject(new Error("offline")));
      vi.stubGlobal("fetch", fetch);
      culpritLoc({ rule: "n-plus-1", title, location: { file: "src/lib/plain.ts", line: 63 } });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
