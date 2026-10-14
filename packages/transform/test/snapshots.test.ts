import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { transformSource } from "../src/index";

const root = path.join(__dirname, "fixture");
const snapshotsDir = path.join(root, "snapshots");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(snapshotsDir, name), "utf8");
}

/** Everything up to the appended `;(function () { … })();` wrapper. */
function stripWrapper(out: string): string {
  const marker = `\n;(function () { var __tpw = globalThis["__hoplens"] && globalThis["__hoplens"].wrap;`;
  const idx = out.indexOf(marker);
  return idx < 0 ? out : out.slice(0, idx);
}

/**
 * For every line in the original, the output line must have the same byte length.
 * The only legitimate textual change is `const` → `let  ` (both 5 chars) at a variable-statement start.
 */
function assertLinesUnchanged(before: string, after: string) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  expect(afterLines.length, "line count must not decrease").toBeGreaterThanOrEqual(beforeLines.length);
  for (let i = 0; i < beforeLines.length; i++) {
    const b = beforeLines[i]!;
    const a = afterLines[i]!;
    expect(a.length, `line ${i + 1} length changed: before=${JSON.stringify(b)} after=${JSON.stringify(a)}`).toBe(
      b.length,
    );
    if (b === a) continue;
    // Normalise the one allowed diff: `let  ` back to `const`.
    const normalised = a.replace(/\blet {2}/g, "const");
    expect(normalised, `line ${i + 1} diffs beyond the const→let  swap`).toBe(b);
  }
}

/** Parse the appended wrapper body and return the list of `name = __tpw(name, {…})` entries. */
function parseWrapperCalls(out: string): { name: string; file: string; line: number }[] {
  const re = /(\w+)\s*=\s*__tpw\(\1,\s*(\{[^}]+\})\)/g;
  const calls: { name: string; file: string; line: number }[] = [];
  for (const m of out.matchAll(re)) {
    const meta = JSON.parse(m[2]!);
    calls.push({ name: m[1]!, file: meta.file, line: meta.line });
  }
  return calls;
}

describe("transform snapshots — no-line-moves invariant", () => {
  const fixtures = fs.readdirSync(snapshotsDir).filter((f) => f.endsWith(".ts"));

  for (const name of fixtures) {
    test(name, () => {
      const src = readFixture(name);
      const out = transformSource(src, path.join(snapshotsDir, name), { root });

      // skipped-shapes.ts has no traceable exports — transformSource returns null.
      if (name === "skipped-shapes.ts") {
        expect(out).toBeNull();
        return;
      }

      expect(out, `${name} should produce an output`).not.toBeNull();
      const body = stripWrapper(out!);
      assertLinesUnchanged(src, body);

      // The wrapper call map must mention every expected export, with the correct source line.
      const calls = parseWrapperCalls(out!);
      expect(calls.length, "wrapper calls detected").toBeGreaterThan(0);
      for (const c of calls) {
        expect(
          c.file.endsWith(`snapshots/${name}`),
          `file in wrapper meta should end with snapshots/${name}, got ${c.file}`,
        ).toBe(true);
        const line = src.split("\n")[c.line - 1] ?? "";
        expect(line, `line ${c.line} should mention ${c.name}`).toContain(c.name);
      }
    });
  }
});

describe("transform snapshots — per-fixture expectations", () => {
  test("async-named-fn: both exported async functions wrapped", () => {
    const out = transformSource(readFixture("async-named-fn.ts"), path.join(snapshotsDir, "async-named-fn.ts"), {
      root,
    })!;
    const names = parseWrapperCalls(out)
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["fetchUser", "listUsers"]);
  });

  test("const-arrow: both wrapped and `const` swapped to `let  `", () => {
    const out = transformSource(readFixture("const-arrow.ts"), path.join(snapshotsDir, "const-arrow.ts"), { root })!;
    // 5-char replacement + original space between const and name = `let` + 3 spaces + name.
    expect(out).toMatch(/export let {3}add\b/);
    expect(out).toMatch(/export let {3}mul\b/);
    expect(
      parseWrapperCalls(out)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["add", "mul"]);
  });

  test("const-async-arrow: wrapped", () => {
    const out = transformSource(readFixture("const-async-arrow.ts"), path.join(snapshotsDir, "const-async-arrow.ts"), {
      root,
    })!;
    expect(parseWrapperCalls(out).map((c) => c.name)).toEqual(["load"]);
  });

  test("mixed-decl: all three function-decls in the compound const are wrapped, PI_LIKE is not", () => {
    const out = transformSource(readFixture("mixed-decl.ts"), path.join(snapshotsDir, "mixed-decl.ts"), { root })!;
    const names = parseWrapperCalls(out)
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["first", "second", "third"]);
    expect(out).not.toMatch(/PI_LIKE = __tpw/);
  });

  test("type-asserted: `as` and `satisfies` wraps are unwrapped and both are traced", () => {
    const out = transformSource(readFixture("type-asserted.ts"), path.join(snapshotsDir, "type-asserted.ts"), {
      root,
    })!;
    expect(
      parseWrapperCalls(out)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["h1", "h2"]);
  });

  test("skipped-shapes: nothing wrapped → transformSource returns null", () => {
    const out = transformSource(readFixture("skipped-shapes.ts"), path.join(snapshotsDir, "skipped-shapes.ts"), {
      root,
    });
    expect(out).toBeNull();
  });

  test("mixed-with-skipped: only `traced` + `alsoTraced` are wrapped", () => {
    const out = transformSource(
      readFixture("mixed-with-skipped.ts"),
      path.join(snapshotsDir, "mixed-with-skipped.ts"),
      {
        root,
      },
    )!;
    const names = parseWrapperCalls(out)
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["alsoTraced", "traced"]);
    expect(out).not.toMatch(
      /defExport = __tpw|generator = __tpw|nonFunction = __tpw|skippedBecauseNotExported = __tpw/,
    );
  });

  test("with-comments: comments and JSDoc preserved verbatim before each export", () => {
    const src = readFixture("with-comments.ts");
    const out = transformSource(src, path.join(snapshotsDir, "with-comments.ts"), { root })!;
    const body = stripWrapper(out);
    expect(body).toContain("A documented helper. The JSDoc must not move.");
    expect(body).toContain("// Standalone comment between exports.");
    expect(body).toContain("// trailing comment");
  });

  test("long-signature: single export, line kept intact", () => {
    const src = readFixture("long-signature.ts");
    const out = transformSource(src, path.join(snapshotsDir, "long-signature.ts"), { root })!;
    const body = stripWrapper(out);
    assertLinesUnchanged(src, body);
    expect(parseWrapperCalls(out).map((c) => c.name)).toEqual(["fetchAndFilter"]);
  });
});
