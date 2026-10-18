import { describe, expect, test } from "vitest";
import type { Route } from "../src/state/router";
import { subjectChrome } from "../src/state/subjectChrome";

/* Run: pnpm --filter @hoplens/ui exec vitest run test/subjectChrome.test.ts */

/** The headers and close buttons the Requests subject shows (bar + builder drawer + request header). */
function chrome(view: Route["view"], builderOpen: boolean) {
  const c = subjectChrome(view, builderOpen);
  const headings = [...(c.bar ? [c.kind as string] : []), ...(builderOpen ? ["New request"] : [])];
  const closes = (c.barClose ? 1 : 0) + (c.drawerClose ? 1 : 0);
  const newRequestLabels = (builderOpen ? 1 : 0) + (view === "trace" && c.traceNewRequest ? 1 : 0);
  return { headings, closes, newRequestLabels, c };
}

describe("subjectChrome", () => {
  test("the builder alone: one 'New request' header and one close, pinned in the drawer head", () => {
    const { headings, closes, c } = chrome("requests", true);
    expect(headings).toEqual(["New request"]);
    expect(closes).toBe(1);
    expect(c.drawerClose).toBe(true);
    expect(c.drawerHeadPinned).toBe(true);
  });

  test("the builder over a request or a compare: one close, on the sticky bar, closing the builder", () => {
    for (const view of ["trace", "compare"] as const) {
      const { headings, closes, newRequestLabels, c } = chrome(view, true);
      expect(headings.filter((h) => h === "New request")).toHaveLength(1);
      expect(new Set(headings).size).toBe(headings.length);
      expect(closes).toBe(1);
      // The sticky bar keeps the close (the phone's "< Back") in view while the user scrolls.
      expect(c.barClose).toBe("builder");
      expect(c.drawerClose).toBe(false);
      // The request header's own "New request" button steps aside while the builder is open.
      expect(newRequestLabels).toBe(1);
    }
  });

  test("without the builder the bar keeps its label and its close closes the subject", () => {
    expect(subjectChrome("trace", false)).toMatchObject({ bar: true, kind: "Request", barClose: "subject" });
    expect(subjectChrome("compare", false)).toMatchObject({ bar: true, kind: "Compare", barClose: "subject" });
    expect(chrome("trace", false).closes).toBe(1);
    expect(subjectChrome("trace", false).traceNewRequest).toBe(true);
  });
});
