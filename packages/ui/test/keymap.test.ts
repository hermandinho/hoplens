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

/* WP1b: display form, modal overlays, guards with the event, the action bar. */

import { activeScopes, barHints, bindings, formatKey, hintOf, modalScope, usableBindings } from "../src/state/keymap";

function withRegs(regs: Array<() => void>, fn: () => void): void {
  try {
    fn();
  } finally {
    for (const off of regs) off();
    modalScope.value = null;
    activeScopes.value = new Set();
  }
}

describe("formatKey", () => {
  test("Mod is Ctrl on Windows/Linux and Cmd on mac", () => {
    expect(formatKey("Mod+k", false)).toBe("Ctrl+K");
    expect(formatKey("Mod+k", true)).toBe("Cmd+K");
    expect(formatKey("Mod+\\", false)).toBe("Ctrl+\\");
    expect(formatKey("Mod+Enter", true)).toBe("Cmd+Enter");
  });

  test("named keys read as on the keycap; plain keys stay as typed", () => {
    expect(formatKey("Escape")).toBe("Esc");
    expect(formatKey(" ")).toBe("Space");
    expect(formatKey("ArrowDown")).toBe("↓");
    expect(formatKey("c c")).toBe("c c");
    expect(formatKey("?")).toBe("?");
    expect(formatKey("R")).toBe("R");
  });
});

describe("modal overlay", () => {
  test("only the modal scope and overModal globals fire while it is open", () => {
    const fired: string[] = [];
    withRegs(
      [
        register("global", "j", "list key", () => fired.push("j")),
        register("global", "?", "sheet", () => fired.push("?"), { overModal: true }),
        register("palette", "ArrowDown", "row", () => fired.push("down")),
      ],
      () => {
        modalScope.value = "palette";
        handleKeydown(key("j"));
        handleKeydown(key("?"));
        handleKeydown(key("ArrowDown"));
        modalScope.value = null;
        handleKeydown(key("j"));
        handleKeydown(key("ArrowDown")); // palette scope not active without the overlay
      },
    );
    expect(fired).toEqual(["?", "down", "j"]);
  });
});

describe("when guards", () => {
  test("receive the keydown being dispatched", () => {
    const seen: unknown[] = [];
    const ev = key("x");
    withRegs(
      [
        register("global", "x", "x", () => {}, {
          when: (e) => {
            seen.push(e);
            return true;
          },
        }),
      ],
      () => {
        handleKeydown(ev);
      },
    );
    expect(seen).toEqual([ev]);
  });
});

describe("action bar", () => {
  test("lists usable context keys, merges neighbours with one hint, and only opted-in globals", () => {
    withRegs(
      [
        register("global", "1", "Go to Overview", () => {}),
        register("global", "Mod+k", "Palette", () => {}, { bar: true, hint: "palette" }),
        register("list", "j", "Next request", () => {}, { hint: "move" }),
        register("list", "k", "Previous request", () => {}, { hint: "move" }),
        register("trace", "f", "Highlight the verdict's cause (and zoom)", () => {}),
        register("trace", "o", "Never here", () => {}, { when: () => false }),
        register("list", "ArrowDown", "alias", () => {}, { hidden: true }),
      ],
      () => {
        activeScopes.value = new Set(["list", "trace"]);
        const hints = barHints(usableBindings(), false).map((h) => `${h.keys.join("/")} ${h.hint}`);
        expect(hints).toEqual(["j/k move", "f Highlight the verdict's cause", "Ctrl+K palette"]);
        activeScopes.value = new Set();
        expect(barHints(usableBindings(), false).map((h) => h.hint)).toEqual(["palette"]);
      },
    );
    expect(bindings.value.length).toBe(0);
  });

  test("hintOf cuts a label at its first parenthesis or colon", () => {
    expect(hintOf({ label: "Reset zoom: full range" })).toBe("Reset zoom");
    expect(hintOf({ label: "Zoom (or the handler)" })).toBe("Zoom");
    expect(hintOf({ label: "x", hint: "short" })).toBe("short");
  });
});

/* R2 integration: several lists share j / k in the "list" scope, each guarded by `when`. */

import { cheatsheet } from "../src/state/keymap";

describe("cheatsheet", () => {
  test("a key shared by guarded bindings shows the one usable now", () => {
    let onQueries = false;
    withRegs(
      [
        register("list", "j", "Next request", () => {}, { when: () => !onQueries }),
        register("list", "j", "Next query shape", () => {}, { when: () => onQueries }),
      ],
      () => {
        const label = () =>
          cheatsheet()
            .find((g) => g.scope === "list")
            ?.items.find((i) => i.key === "j")?.label;
        expect(label()).toBe("Next request");
        onQueries = true;
        expect(label()).toBe("Next query shape");
        expect(
          cheatsheet()
            .find((g) => g.scope === "list")
            ?.items.filter((i) => i.key === "j"),
        ).toHaveLength(1);
      },
    );
  });

  test("in a live scope, a key that is guarded off everywhere is not listed", () => {
    let onLog = false;
    activeScopes.value = new Set(["list"]);
    try {
      withRegs(
        [register("list", "Enter", "Open the request under the cursor", () => {}, { when: () => onLog })],
        () => {
          const keys = () =>
            cheatsheet()
              .find((g) => g.scope === "list")
              ?.items.map((i) => i.key) ?? [];
          expect(keys()).not.toContain("Enter");
          onLog = true;
          expect(keys()).toContain("Enter");
          // Not live: listed as what it would do there.
          onLog = false;
          activeScopes.value = new Set();
          expect(keys()).toContain("Enter");
        },
      );
    } finally {
      activeScopes.value = new Set();
    }
  });
});
