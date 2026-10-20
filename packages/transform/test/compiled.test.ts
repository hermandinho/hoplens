// COMPILED mode (transformCompiled): tsx's esbuild output of the fixture/tsx cases, pinned as real
// output of the tsx version in each file name, mapped back to the raw TypeScript on disk.
//
// Refresh the pinned output after a tsx upgrade (once the drift test below passes or was re-verified);
// it writes <case>.tsx-<new>.mjs and removes the old version's files, and PINNED is read off the names:
//   UPDATE_TSX_FIXTURES=1 pnpm --filter @hoplens/transform test compiled
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type CompiledResult, transformCompiled } from "../src/index";
import {
  TSX_FIXTURES,
  compileWithTsx,
  compiledFixture,
  installedTsx,
  pinTsxFixtures,
  pinnedTsxVersion,
  tsxCases,
} from "./tsx-compile";

const root = TSX_FIXTURES;
const TSX = installedTsx();
const REVERIFY =
  "Re-verify transformCompiled on the new output, then refresh the fixtures with UPDATE_TSX_FIXTURES=1 (it replaces the old version's files).";

if (process.env.UPDATE_TSX_FIXTURES && TSX) pinTsxFixtures(compileWithTsx(TSX.cli), TSX.version);

/** The tsx version the committed fixtures come from (their file names say which). */
const PINNED = pinnedTsxVersion();

const raw = (name: string) => fs.readFileSync(path.join(root, `${name}.ts`), "utf8");
const pinned = (name: string) => fs.readFileSync(compiledFixture(name, PINNED), "utf8");
const run = (name: string, compiled = pinned(name), src = raw(name)): CompiledResult =>
  transformCompiled(compiled, src, path.join(root, `${name}.ts`), { root });

/** The (binding, meta) pairs the trailer rebinds. */
function rebinds(r: CompiledResult): { binding: string; meta: { name: string; file: string; line: number } }[] {
  if (r.kind !== "wrapped") return [];
  return [...r.code.matchAll(/(\w+) = __tpw\(\1, (\{[^}]*\})\);/g)].map((m) => ({
    binding: m[1]!,
    meta: JSON.parse(m[2]!),
  }));
}

/** What each case must come out as: the functions wrapped (name and raw line), or a refusal. */
const EXPECTED: Record<string, { wraps?: [string, number][]; refused?: RegExp }> = {
  async: {
    wraps: [
      ["load", 1],
      ["save", 6],
    ],
  },
  "const-arrow": {
    wraps: [
      ["listUsers", 3],
      ["sum", 7],
      ["typed", 11],
    ],
  },
  decorators: { wraps: [["useService", 12]] },
  "default-class": { wraps: [["real", 9]] },
  "enum-namespace": { wraps: [["paint", 16]] },
  "fn-decl": {
    wraps: [
      ["getUser", 6],
      ["boom", 10],
    ],
  },
  overloads: { wraps: [["pick", 3]] },
  renamed: {
    wraps: [
      ["inner", 1],
      ["local", 5],
    ],
  },
  shapes: {},
  // esbuild lowers a top-level `using` by moving the module's bindings into a try block.
  using: { refused: /^later: not one top-level function binding/ },
  "value-use": { wraps: [["plain", 7]] },
};

describe("pinned tsx output", () => {
  test("a refresh for a new tsx replaces the old version's fixtures, so PINNED follows it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-pin-"));
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "");
      fs.writeFileSync(path.join(dir, "a.tsx-1.0.0.mjs"), "old");
      expect(pinnedTsxVersion(dir)).toBe("1.0.0");
      pinTsxFixtures({ a: "new" }, "1.1.0", dir);
      expect(pinnedTsxVersion(dir)).toBe("1.1.0");
      expect(fs.readdirSync(dir).sort()).toEqual(["a.ts", "a.tsx-1.1.0.mjs"]);
      fs.writeFileSync(path.join(dir, "b.tsx-1.0.0.mjs"), "stray");
      expect(() => pinnedTsxVersion(dir)).toThrow(/exactly one tsx version/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every case has a pinned compiled fixture and an expectation", () => {
    expect(tsxCases()).toEqual(Object.keys(EXPECTED).sort());
    for (const c of tsxCases()) expect(fs.existsSync(compiledFixture(c, PINNED)), c).toBe(true);
  });

  test.each(Object.keys(EXPECTED).sort())("%s", (name) => {
    const want = EXPECTED[name]!;
    const compiled = pinned(name);
    const r = run(name);
    if (want.refused) {
      expect(r.kind).toBe("refused");
      expect(r.kind === "refused" && r.reason).toMatch(want.refused);
      return;
    }
    if (!want.wraps) {
      expect(r).toEqual({ kind: "none" });
      return;
    }
    expect(r.kind).toBe("wrapped");
    if (r.kind !== "wrapped") return;
    expect(r.fns).toBe(want.wraps.length);
    expect(rebinds(r).map((x) => [x.meta.name, x.meta.line])).toEqual(want.wraps);
    for (const x of rebinds(r)) expect(x.meta.file).toBe(`${name}.ts`);
    // Nothing before EOF moved: the compiled source is a prefix, but for same-length const -> let swaps.
    const head = r.code.slice(0, compiled.length);
    expect(head.length).toBe(compiled.length);
    expect(head.replace(/\blet {2}/g, "const")).toBe(compiled);
    expect(r.code.slice(compiled.length)).toMatch(/^\n;\(function \(\) \{[^\n]*\}\)\(\);\n$/);
    // The source map comment is untouched, and the trailer brings no other.
    expect(r.code.match(/\/\/# sourceMappingURL=/g)).toHaveLength(1);
  });

  test("a renamed export rebinds the compiled local and reports the raw name", () => {
    const r = rebinds(run("renamed"));
    expect(r.map((x) => x.binding)).toEqual(["inner", "local"]);
    expect(pinned("renamed")).toMatch(/export\s*\{[^}]*inner as doubled/);
  });

  test("the wrapped module still runs, and its exports go through the wrapper", async () => {
    const r = run("fn-decl");
    if (r.kind !== "wrapped") throw new Error(r.kind);
    const seen: string[] = [];
    const g = globalThis as any;
    const before = g.__hoplens;
    g.__hoplens = {
      wrap(fn: any, meta: any) {
        seen.push(meta.name);
        const w = (...a: unknown[]) => fn(...a);
        w.__hoplens = true;
        return w;
      },
    };
    try {
      const mod = await import(`data:text/javascript;base64,${Buffer.from(r.code).toString("base64")}`);
      expect(mod.getUser(3)).toEqual({ id: 3, name: "user 3" });
      expect(mod.getUser.__hoplens).toBe(true);
      expect(seen).toEqual(["getUser", "boom"]);
    } finally {
      g.__hoplens = before;
    }
  });
});

describe.skipIf(!TSX)("installed tsx", () => {
  test("its output for every case has the shape COMPILED mode was verified on", () => {
    const now = compileWithTsx(TSX!.cli);
    for (const name of tsxCases()) {
      const was = pinned(name);
      const is = now[name]!;
      if (TSX!.version === PINNED) {
        expect(
          is,
          `tsx ${PINNED} now compiles ${name}.ts differently from the pinned fixture (esbuild's output shape drifted?). ${REVERIFY}`,
        ).toBe(was);
        continue;
      }
      const a = run(name, was);
      const b = run(name, is);
      const describeResult = (r: CompiledResult) =>
        r.kind === "wrapped" ? rebinds(r).map((x) => `${x.binding}:${x.meta.name}:${x.meta.line}`) : r.kind;
      expect(
        describeResult(b),
        `esbuild's output shape drifted: tsx ${TSX!.version} compiles ${name}.ts so COMPILED mode now gives ${JSON.stringify(describeResult(b))} instead of ${JSON.stringify(describeResult(a))} (pinned tsx ${PINNED}). ${REVERIFY}`,
      ).toEqual(describeResult(a));
    }
  }, 60000);

  test("a coverage run (NODE_V8_COVERAGE) compiles the same pinned output", () => {
    const before = process.env.NODE_V8_COVERAGE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-v8cov-"));
    process.env.NODE_V8_COVERAGE = dir;
    try {
      const now = compileWithTsx(TSX!.cli, ["fn-decl"]);
      if (TSX!.version === PINNED) expect(now["fn-decl"]).toBe(pinned("fn-decl"));
      const map = JSON.parse(Buffer.from(now["fn-decl"]!.split("base64,").pop()!, "base64").toString("utf8"));
      expect(map.sourcesContent).toEqual([null]);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "NODE_V8_COVERAGE");
      else process.env.NODE_V8_COVERAGE = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("refusals and no-ops", () => {
  const file = path.join(root, "x.ts");
  const go = (compiled: string, src: string) => transformCompiled(compiled, src, file, { root });
  const SRC = "export function f(a: number) {\n  return a;\n}\n";

  test("nothing to wrap in the raw source: none", () => {
    expect(go("const x=1;export{x};", "export const x: number = 1;\n")).toEqual({ kind: "none" });
    expect(go("console.log(1);", "console.log(1 as number);\n")).toEqual({ kind: "none" });
  });

  test("a raw source that does not parse: none (the compiled one loads as it is)", () => {
    expect(go("function f(a){return a}export{f};", "export function f(a: number) {\n  return a;\n")).toEqual({
      kind: "none",
    });
  });

  test("a compiled source that does not parse is refused", () => {
    expect(go("function f(a){return a}export{f", SRC)).toMatchObject({ kind: "refused" });
  });

  test("a name the raw source exports but the compiled one does not is refused", () => {
    expect(go("function f(a){return a}export{f as g};", SRC)).toEqual({
      kind: "refused",
      reason: "f: not a local export of the compiled source",
    });
    expect(go('export{f}from"./other.js";', SRC)).toMatchObject({ kind: "refused" });
  });

  test("a string-literal export name maps like an identifier one", () => {
    const src = 'export function keep() {\n  return "keep";\n}\nconst s = () => "s";\nexport { s as "str-name" };\n';
    const r = go(
      'function keep(){return"keep"}__name(keep,"keep");const s=__name(()=>"s","s");export{keep,s as"str-name"};',
      src,
    );
    expect(rebinds(r).map((x) => [x.binding, x.meta.name, x.meta.line])).toEqual([
      ["keep", "keep", 1],
      ["s", "s", 4],
    ]);
    // A string-named re-export from another module is still not a local export.
    expect(go('function keep(){return"keep"}export{keep};export{"x" as"str-name"}from"./o.js";', src)).toMatchObject({
      kind: "refused",
    });
  });

  test("an export clause naming two different locals is refused", () => {
    expect(go("function f(a){return a}function h(){}export{f};export{h as f};", SRC)).toMatchObject({
      kind: "refused",
    });
  });

  test("a binding that is not one top-level function is refused", () => {
    for (const compiled of [
      "var f=g(a=>a);export{f};",
      "var f;f=a=>a;export{f};",
      "function f(a){return a}var f;export{f};",
      "class f{}export{f};",
      "var _s=[];try{var f=a=>a}finally{}export{f};",
      "function*f(a){yield a}export{f};",
      "var{f}={f:a=>a};export{f};",
    ]) {
      expect(go(compiled, SRC), compiled).toMatchObject({ kind: "refused" });
    }
  });

  test("a top-level binding also declared by a nested `var` is refused", () => {
    const src = "export var f = (a: number) => a;\n";
    expect(go("var f=a=>a;export{f};", src).kind).toBe("wrapped");
    expect(go("var f=a=>a;try{var f=g()}finally{}export{f};", src)).toMatchObject({ kind: "refused" });
    expect(go("var f=a=>a;for(var f of[]);export{f};", src)).toMatchObject({ kind: "refused" });
  });

  test("a function of a different kind or async-ness is refused", () => {
    expect(go("const f=a=>a;export{f};", SRC)).toEqual({
      kind: "refused",
      reason: "f: a different kind of function in the compiled source",
    });
    expect(go("async function f(a){return a}export{f};", SRC)).toMatchObject({ kind: "refused" });
  });

  test("exported declarations in the compiled source map too, and only raw targets are touched", () => {
    const r = go("export function f(a){return a}export const h=()=>1;", SRC);
    expect(rebinds(r).map((x) => x.binding)).toEqual(["f"]);
    expect(r.kind === "wrapped" && r.code.startsWith("export function f(a){return a}export const h")).toBe(true);
  });

  test("a value use in the raw source skips that function, whatever the compiled source does", () => {
    const src = "export function f() {\n  return 1;\n}\nexport const all = [f];\nexport function k() {}\n";
    const r = go("function f(){return 1}const all=[f];function k(){}export{all,f,k};", src);
    expect(rebinds(r).map((x) => x.meta.name)).toEqual(["k"]);
  });
});
