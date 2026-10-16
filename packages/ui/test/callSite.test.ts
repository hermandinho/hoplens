import { describe, expect, test } from "vitest";
import { calleeOfTitle, findCallLine } from "../src/state/callSite";

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
});
