import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { collectTargets, mayHaveTargets, presetExcludes, shouldTrace, transformSource } from "../src/index";

const root = path.join(__dirname, "fixture");
const node = { root, preset: "node" as const };
const at = (rel: string) => path.join(root, rel);

/** Every original line keeps its length; the only allowed change is `const` → `let  `. */
function assertLinesUnchanged(before: string, after: string) {
  const b = before.split("\n");
  const a = after.split("\n");
  for (let i = 0; i < b.length - 1; i++) {
    expect(a[i]!.length, `line ${i + 1} changed length`).toBe(b[i]!.length);
    expect(a[i]!.replace(/\blet {2}/g, "const"), `line ${i + 1}`).toBe(b[i]);
  }
}

const wrapped = (out: string | null) => [...(out ?? "").matchAll(/(\w+) = __tpw\(\1, (\{[^}]+\})\)/g)].map((m) => m[1]);

describe("presets", () => {
  test("node traces Next-reserved paths and skips config, tests, build output and node_modules", () => {
    const src = "export function a() {}";
    for (const rel of ["src/app/x.ts", "pages/a.js", "app/b.mjs", "src/middleware.ts", "proxy.cts", "src/lib/c.ts"]) {
      expect(shouldTrace(at(rel), src, node), rel).toBe(true);
    }
    for (const rel of [
      "src/a.config.ts",
      "vite.config.mjs",
      "x.test.ts",
      "src/deep/x.spec.js",
      "src/__tests__/a.ts",
      "src/types.d.ts",
      "node_modules/pkg/index.js",
      "src/node_modules/pkg/a.js",
      "dist/server.js",
      "build/a.js",
      "out/a.js",
    ]) {
      expect(shouldTrace(at(rel), src, node), rel).toBe(false);
    }
    expect(shouldTrace(at("src/a.ts"), '"use server";\nexport function a() {}', node)).toBe(false);
  });

  test("next stays the default: Next entry files excluded, nested config files are not", () => {
    const src = "export function a() {}";
    for (const opts of [{ root }, { root, preset: "next" as const }]) {
      expect(shouldTrace(at("src/app/x.ts"), src, opts)).toBe(false);
      expect(shouldTrace(at("pages/a.js"), src, opts)).toBe(false);
      expect(shouldTrace(at("next.config.ts"), src, opts)).toBe(false);
      expect(shouldTrace(at("src/a.config.ts"), src, opts)).toBe(true);
      expect(shouldTrace(at("dist/a.js"), src, opts)).toBe(true);
    }
    expect(presetExcludes(undefined)).toBe(presetExcludes("next"));
    expect(presetExcludes("node")).not.toContain("src/app/**");
  });

  test("user include/exclude still apply on top of the node preset", () => {
    const src = "export function a() {}";
    expect(shouldTrace(at("src/lib/a.ts"), src, { ...node, include: ["src/services/**"] })).toBe(false);
    expect(shouldTrace(at("src/services/a.ts"), src, { ...node, include: ["src/services/**"] })).toBe(true);
    expect(shouldTrace(at("src/services/a.ts"), src, { ...node, exclude: ["src/services/**"] })).toBe(false);
  });

  test("node: build output is in scope only through an include glob naming its dir", () => {
    const src = "exports.a = function () {};";
    expect(shouldTrace(at("dist/a.js"), src, { ...node, include: ["dist/**"] })).toBe(true);
    expect(shouldTrace(at("build/lib/a.js"), src, { ...node, include: ["src/**", "build/lib/**"] })).toBe(true);
    // A broad glob never pulls compiled output in, nor does an include naming another dir.
    expect(shouldTrace(at("dist/a.js"), src, { ...node, include: ["**"] })).toBe(false);
    expect(shouldTrace(at("dist/a.js"), src, { ...node, include: ["build/**"] })).toBe(false);
    // Everything else still applies inside it: tests, declarations, node_modules, the user's excludes.
    for (const rel of ["dist/a.test.js", "dist/a.d.ts", "dist/node_modules/x.js"]) {
      expect(shouldTrace(at(rel), src, { ...node, include: ["dist/**"] }), rel).toBe(false);
    }
    expect(shouldTrace(at("dist/a.js"), src, { ...node, include: ["dist/**"], exclude: ["dist/a.js"] })).toBe(false);
    // The Next preset never had the output excludes.
    expect(shouldTrace(at("dist/a.js"), src, { root, include: ["dist/**"] })).toBe(true);
  });
});

describe("mayHaveTargets", () => {
  test("false only when no export token exists", () => {
    expect(mayHaveTargets("const a = 1;\nfunction b() {}\n")).toBe(false);
    expect(mayHaveTargets("import x from 'y';\nx();")).toBe(false);
    expect(mayHaveTargets("export function a() {}")).toBe(true);
    expect(mayHaveTargets("const a = () => 1;\nexport { a };")).toBe(true);
    expect(mayHaveTargets("module.exports = { a };")).toBe(true);
    expect(mayHaveTargets("exports.a = a;")).toBe(true);
    expect(mayHaveTargets("const exporter = 1; const reexported = 2;")).toBe(false);
  });

  test("transformSource returns null on a failed prescan without loading anything", () => {
    expect(transformSource("function a() {}\na();\n", at("src/a.ts"), node)).toBeNull();
  });
});

describe("export clauses (node preset)", () => {
  const SRC = [
    "function f(a: number) {",
    "  return a + 1;",
    "}",
    "const g = async () => 2, notFn = 3;",
    "let h = function () { return 3; };",
    "var v = (x: number) => x;",
    "export { f, g as getG };",
    "export { h, v as vee, f as again };",
    "",
  ].join("\n");

  test("wraps each local once, keeps every line, swaps the const keyword", () => {
    const out = transformSource(SRC, at("src/svc.ts"), node)!;
    expect(out).not.toBeNull();
    expect(wrapped(out)).toEqual(["f", "g", "h", "v"]);
    expect(out).toMatch(/^let {3}g = async/m);
    assertLinesUnchanged(SRC, out);
    const found = collectTargets(SRC, at("src/svc.ts"), node)!;
    expect(found.targets).toEqual([
      { name: "f", exported: "f", line: 1 },
      { name: "g", exported: "getG", line: 4 },
      { name: "h", exported: "h", line: 5 },
      { name: "v", exported: "vee", line: 6 },
    ]);
    expect(found.constStarts).toHaveLength(1);
  });

  test("does not double-wrap a function exported directly and through a clause", () => {
    const src = "export function f() {}\nexport const k = () => 1;\nexport { f as alias, k as kay };\n";
    const out = transformSource(src, at("src/a.ts"), node)!;
    expect(wrapped(out)).toEqual(["f", "k"]);
    expect(out.match(/let {2}/g)).toHaveLength(1);
  });

  test("leaves re-exports, imports, classes, defaults and ambiguous names untouched", () => {
    const cases = [
      "export { f } from './x';",
      "export * from './x';",
      "import { f } from './x';\nexport { f };",
      "import f from './x';\nexport { f };",
      "import * as f from './x';\nexport { f };",
      "class f {}\nexport { f };",
      "enum f { A }\nexport { f };",
      "function f() {}\nnamespace f { export const x = 1; }\nexport { f };",
      "function f() {}\nexport { f as default };",
      "function f() {}\nexport { f as default, f };",
      "function* f() {}\nexport { f };",
      "const f = 42;\nexport { f };",
      "const f = make();\nexport { f };",
      "const { f } = obj;\nexport { f };",
      "var f = () => 1;\nvar f = () => 2;\nexport { f };",
      "type f = () => void;\nexport type { f };",
      "declare function f(): void;\nexport { f };",
      "function f() {}\nexport { type f };",
      "export {};",
      "using f = () => 1;\nexport { f };",
      "await using f = () => 1;\nexport { f };",
    ];
    for (const src of cases) expect(transformSource(src, at("src/a.ts"), node), src).toBeNull();
  });

  test("overloads resolve to the implementation", () => {
    const src =
      "function f(a: string): string;\nfunction f(a: number): number;\nfunction f(a: any) { return a; }\nexport { f };\n";
    expect(collectTargets(src, at("src/a.ts"), node)!.targets).toEqual([{ name: "f", exported: "f", line: 3 }]);
  });

  test("the next preset ignores clauses (Next output unchanged)", () => {
    expect(transformSource(SRC, at("src/svc.ts"), { root })).toBeNull();
    expect(transformSource(SRC, at("src/svc.ts"), { root, preset: "next" })).toBeNull();
  });

  test("the wrapped module runs: clause exports and local calls see the wrapper", async () => {
    const src = [
      "function f(a) { return a + 1; }",
      "const g = (a) => f(a) * 2;",
      "export { f, g as double };",
      "export const callF = (a) => f(a);",
      "",
    ].join("\n");
    // The native realpath expands a Windows 8.3 temp dir (`C:\Users\RUNNER~1` on GitHub runners):
    // pathToFileURL encodes `~` as `%7E`, and vite's module loader does not find the encoded path.
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-clause-")));
    const file = path.join(dir, "svc.mjs");
    const out = transformSource(src, file, { root: dir, preset: "node" })!;
    fs.writeFileSync(file, out);
    const seen: string[] = [];
    const g = globalThis as any;
    const prev = g.__hoplens;
    g.__hoplens = {
      wrap: (fn: any, meta: { name: string }) =>
        function (this: any, ...args: any[]) {
          seen.push(meta.name);
          return fn.apply(this, args);
        },
    };
    try {
      const mod = await import(pathToFileURL(file).href);
      expect(mod.f(1)).toBe(2);
      expect(mod.double(1)).toBe(4);
      expect(mod.callF(1)).toBe(2);
      expect(seen).toEqual(["f", "g", "f", "callF", "f"]);
    } finally {
      g.__hoplens = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parse errors (node preset)", () => {
  test("a file that does not parse is left alone, so it fails as without Hoplens", () => {
    const src = "export function f() {\n  return 1;\n";
    expect(transformSource(src, at("src/bad.js"), node)).toBeNull();
    expect(transformSource("export const f = (a) => a +;\n", at("src/bad.ts"), node)).toBeNull();
    // The next preset keeps its exact behaviour.
    expect(transformSource(src, at("src/lib/bad.js"), { root })).not.toBeNull();
  });
});

describe("functions whose identity the module already handed out (node preset)", () => {
  const names = (src: string, rel = "src/a.js") => collectTargets(src, at(rel), node)!.targets.map((t) => t.name);

  test("a function used as a value anywhere in the file is not wrapped", () => {
    const cases = [
      "export function onPing() {}\nbus.on('ping', onPing);",
      "export function f() {}\nexport const registry = new Set([f]);",
      "export function f() {}\nconst handlers = { f };",
      "export function f() {}\nconst handlers = { ping: f };",
      "export function f() {}\nexport default f;",
      "export function f() {}\nexport function stop() { bus.off('x', f); }",
      "export function f() {}\nf.cache = new Map();",
      "export function f() {}\nconst g = f;",
      "export function f() {}\nsetTimeout(f, 1);",
      "export function f() {}\nif (typeof f === 'function') {}",
      "export function f() {}\nnew f();",
      "export function f() {}\nclass C extends f {}",
      "function f() {}\nexport { f };\nmap.set('k', f);",
      "export const f = () => 1;\nlist.push(f);",
      "export function f() {}\nexport const g = [1].map(f);",
    ];
    for (const src of cases) expect(names(src), src).not.toContain("f");
  });

  test("constructor-style functions (this in a non-arrow body) are not wrapped", () => {
    expect(names("export function Point(x) { this.x = x; }")).toEqual([]);
    expect(names("export const P = function (x) { this.x = x; };")).toEqual([]);
    // `this` inside a nested arrow is still the function's own this.
    expect(names("export function P(x) { const s = () => this; }")).toEqual([]);
    // Inside a nested function or class it is not.
    expect(names("export function f() { return function () { return this; }; }")).toEqual(["f"]);
    expect(names("export function f() { return class { m() { return this; } }; }")).toEqual(["f"]);
    // An arrow's `this` is the module's.
    expect(names("export const f = () => this;")).toEqual(["f"]);
  });

  test("a function that calls itself is not wrapped: every level would go through the wrapper", () => {
    expect(names("export function depth(n) { return n === 0 ? 0 : 1 + depth(n - 1); }")).toEqual([]);
    expect(names("export const walk = (t) => t.kids.forEach((k) => walk(k));")).toEqual([]);
    expect(names("export const fact = function (n) { return n < 2 ? 1 : n * fact(n - 1); };")).toEqual([]);
    // A call of it from another function is fine.
    expect(names("export function a() { return 1; }\nexport function b() { return a(); }")).toEqual(["a", "b"]);
  });

  test("calls, property names, type positions and the export clause do not count as uses", () => {
    const src = [
      "export function f(a: number) { return a > 0 ? h(a - 1) : 0; }",
      "export function g() { return f(1) + obj.f + o.f() + tag`x`; }",
      "const o = { f: 1, f2() {}, get f3() { return 1; } };",
      "type T = ReturnType<typeof f>;",
      "interface I { f: typeof f }",
      "export { f as alias };",
      "",
    ].join("\n");
    expect(names(src, "src/a.ts")).toEqual(["f", "g"]);
  });

  test("a const statement keeps `const` when none of its functions is wrapped", () => {
    const src = "export const f = () => 1, g = () => 2;\nuse(f, g);\n";
    expect(transformSource(src, at("src/a.js"), node)).toBeNull();
    const one = "export const f = () => 1, g = () => 2;\nuse(f);\n";
    const out = transformSource(one, at("src/a.js"), node)!;
    expect(wrapped(out)).toEqual(["g"]);
    expect(out.startsWith("export let   f")).toBe(true);
  });

  test("the next preset is unchanged", () => {
    const src = "export function onPing() {}\nbus.on('ping', onPing);\nexport function P() { this.x = 1; }\n";
    expect(collectTargets(src, at("src/lib/a.js"), { root })!.targets.map((t) => t.name)).toEqual(["onPing", "P"]);
  });

  test("the wrapped module keeps listener identity", async () => {
    const src = [
      'import { EventEmitter } from "node:events";',
      "export const bus = new EventEmitter();",
      "export function onPing() { return 'pong'; }",
      "bus.on('ping', onPing);",
      "export function stop() { bus.off('ping', onPing); return bus.listenerCount('ping'); }",
      "export function plain(a) { return a + 1; }",
      "",
    ].join("\n");
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-ident-")));
    const file = path.join(dir, "bus.mjs");
    const out = transformSource(src, file, { root: dir, preset: "node" })!;
    expect(wrapped(out)).toEqual(["stop", "plain"]);
    fs.writeFileSync(file, out);
    const g = globalThis as any;
    const prev = g.__hoplens;
    g.__hoplens = {
      wrap: (fn: any) =>
        function (this: any, ...args: any[]) {
          return fn.apply(this, args);
        },
    };
    try {
      const mod = await import(pathToFileURL(file).href);
      expect(mod.stop()).toBe(0);
      mod.bus.on("ping", mod.onPing);
      mod.bus.off("ping", mod.onPing);
      expect(mod.bus.listenerCount("ping")).toBe(0);
    } finally {
      g.__hoplens = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
