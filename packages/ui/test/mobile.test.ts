import { describe, expect, test } from "vitest";
import { SWIPE_MAX_MS, SWIPE_MIN_PX, neighbourId, swipeIntent } from "../src/state/mobile";

/* Run: pnpm --filter @hoplens/ui exec vitest run test/mobile.test.ts */

describe("swipeIntent", () => {
  test("a quick leftward flick opens the older request, rightward the newer", () => {
    expect(swipeIntent({ dx: -120, dy: 10, dt: 200 })).toBe("older");
    expect(swipeIntent({ dx: 120, dy: -10, dt: 200 })).toBe("newer");
  });

  test("a short move is a tap, not a swipe", () => {
    expect(swipeIntent({ dx: -(SWIPE_MIN_PX - 1), dy: 0, dt: 100 })).toBeNull();
    expect(swipeIntent({ dx: -SWIPE_MIN_PX, dy: 0, dt: 100 })).toBe("older");
  });

  test("a mostly vertical move is a scroll", () => {
    expect(swipeIntent({ dx: -100, dy: 60, dt: 200 })).toBeNull();
    expect(swipeIntent({ dx: -100, dy: 50, dt: 200 })).toBe("older");
  });

  test("a slow drag is not a flick", () => {
    expect(swipeIntent({ dx: -200, dy: 0, dt: SWIPE_MAX_MS + 1 })).toBeNull();
  });

  test("garbage input is ignored", () => {
    expect(swipeIntent({ dx: Number.NaN, dy: 0, dt: 100 })).toBeNull();
    expect(swipeIntent({ dx: -200, dy: 0, dt: -5 })).toBeNull();
  });
});

describe("neighbourId", () => {
  const rows = [{ id: "c" }, { id: "b" }, { id: "a" }]; // newest first

  test("newer is the row above, older the row below", () => {
    expect(neighbourId(rows, "b", "newer")).toBe("c");
    expect(neighbourId(rows, "b", "older")).toBe("a");
  });

  test("stops at both ends and for an unlisted id", () => {
    expect(neighbourId(rows, "c", "newer")).toBeUndefined();
    expect(neighbourId(rows, "a", "older")).toBeUndefined();
    expect(neighbourId(rows, "zz", "older")).toBeUndefined();
    expect(neighbourId(rows, null, "older")).toBeUndefined();
  });
});
