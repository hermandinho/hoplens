import { describe, expect, test } from "vitest";
import { scopesFor, stepEpoch } from "../src/state/shellKeys";

/* WP1b shell keys: e / E scope stepping and the scopes a route makes live.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/shellKeys.test.ts */

describe("e / E: step the since scope through the edits", () => {
  const epochs = [2, 5, 7];
  test("e with no scope starts at the newest edit, then walks older", () => {
    expect(stepEpoch(epochs, undefined, -1)).toBe(7);
    expect(stepEpoch(epochs, 7, -1)).toBe(5);
    expect(stepEpoch(epochs, 5, -1)).toBe(2);
    expect(stepEpoch(epochs, 2, -1)).toBeUndefined();
  });
  test("E walks newer and clears the scope past the newest edit", () => {
    expect(stepEpoch(epochs, 2, 1)).toBe(5);
    expect(stepEpoch(epochs, 7, 1)).toBeNull();
    expect(stepEpoch(epochs, undefined, 1)).toBeUndefined();
  });
  test("a scope on an edit no longer retained still steps to its neighbours", () => {
    expect(stepEpoch(epochs, 6, -1)).toBe(5);
    expect(stepEpoch(epochs, 6, 1)).toBe(7);
  });
  test("no edits: nowhere to go", () => {
    expect(stepEpoch([], undefined, -1)).toBeUndefined();
  });
});

describe("scopes from the route", () => {
  const s = (r: Parameters<typeof scopesFor>[0]) => [...scopesFor(r, null)].sort();
  test("an open request makes list, subject and trace live", () => {
    expect(s({ view: "trace", traceId: "t1" })).toEqual(["list", "subject", "trace"]);
  });
  test("the overview is a list (routes), with a subject only with a route open", () => {
    expect(s({ view: "overview" })).toEqual(["list"]);
    expect(s({ view: "overview", routeKey: "GET /api/feed" })).toEqual(["list", "subject"]);
  });
  test("queries is a list, with a subject when a shape is open", () => {
    expect(s({ view: "queries" })).toEqual(["list"]);
    expect(s({ view: "queries", shape: "db:SELECT 1" })).toEqual(["list", "subject"]);
  });
});
