import { describe, expect, test } from "vitest";
import { handleKeydown, register } from "../src/state/keymap";

/* Run: pnpm --filter @hoplens/ui exec vitest run test/keymap.test.ts */

function key(k: string): KeyboardEvent {
  return {
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    target: null,
    preventDefault() {},
  } as unknown as KeyboardEvent;
}

describe("keymap sequences", () => {
  test("a third stroke after a completed 'c c' starts over instead of firing the sequence again", () => {
    const fired: string[] = [];
    const offs = [
      register("global", "c", "single", () => fired.push("c")),
      register("global", "c c", "sequence", () => fired.push("cc")),
    ];
    handleKeydown(key("c"));
    handleKeydown(key("c"));
    handleKeydown(key("c"));
    for (const off of offs) off();
    expect(fired).toEqual(["c", "cc", "c"]);
  });
});
