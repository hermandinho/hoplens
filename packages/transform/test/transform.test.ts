import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { globToRegExp, shouldTrace, transformSource } from "../src/index";

const root = path.join(__dirname, "fixture");

describe("transform", () => {
  test("wraps exported functions without moving any line", () => {
    const file = path.join(root, "src/lib/math.ts");
    const src = fs.readFileSync(file, "utf8");
    expect(shouldTrace(file, src, { root })).toBe(true);

    const out = transformSource(src, file, { root })!;
    const before = src.split("\n");
    const after = out.split("\n");
    for (let i = 0; i < before.length - 1; i++) {
      expect(after[i]!.length, `line ${i + 1} changed length`).toBe(before[i]!.length);
    }
    expect(out).toMatch(/add = __tpw\(add, \{"name":"add","file":"src\/lib\/math.ts","line":2\}\)/);
    expect(out).toMatch(/mul = __tpw\(mul/);
    expect(out).toMatch(/export let {3}mul/);
    expect(out).not.toMatch(/gen = __tpw|dflt = __tpw|internal = __tpw|PI = __tpw/);
  });

  test("never traces routes, pages, proxy or client modules", () => {
    expect(shouldTrace(path.join(root, "src/app/api/x/route.ts"), "", { root })).toBe(false);
    expect(shouldTrace(path.join(root, "src/proxy.ts"), "", { root })).toBe(false);
    expect(shouldTrace(path.join(root, "src/lib/a.ts"), '"use client";\nexport function a() {}', { root })).toBe(false);
    expect(
      shouldTrace(path.join(root, "src/lib/a.ts"), "// hi\n'use server'\nexport async function a() {}", { root }),
    ).toBe(false);
    expect(
      shouldTrace(path.join(root, "src/lib/a.ts"), "export function a() {}", { root, include: ["src/services/**"] }),
    ).toBe(false);
  });

  test("glob matching", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("{*.ts,*.js}").test("x.js")).toBe(true);
    expect(globToRegExp("app/**").test("src/app/x")).toBe(false);
  });
});
