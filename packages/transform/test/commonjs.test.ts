// transformCommonJS: the CommonJS export shapes and their descriptor-checked trailer, run as real
// CommonJS modules (Module#_compile), strict mode included.
import Module from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mayHaveCommonJSTargets, transformCommonJS } from "../src/index";

const root = path.join(__dirname, "fixture");
const opts = { root };
const at = (rel: string) => path.join(root, rel);

interface Meta {
  name: string;
  file: string;
  line: number;
}

let metas: Meta[];
/** Calls that went through a wrapper, by hop name. */
let calls: Record<string, number>;
beforeEach(() => {
  metas = [];
  calls = {};
  (globalThis as any).__hoplens = {
    wrap(fn: any, meta: Meta) {
      metas.push(meta);
      const w = function (this: unknown, ...a: unknown[]) {
        calls[meta.name] = (calls[meta.name] ?? 0) + 1;
        return fn.apply(this, a);
      };
      (w as any).__hoplens = true;
      return w;
    },
  };
});
afterEach(() => {
  (globalThis as any).__hoplens = undefined;
});

/** Compile `code` as the CommonJS module `rel` and return its module.exports. */
function load(rel: string, code: string): any {
  const file = at(rel);
  const m = new (Module as any)(file);
  m.filename = file;
  m.paths = [];
  m._compile(code, file);
  return m.exports;
}

/** Transform `src` as `rel` (must produce a trailer), check no original byte moved, and load it. */
function wrapAndLoad(rel: string, src: string): { exports: any; fns: number } {
  const r = transformCommonJS(src, at(rel), opts);
  expect(r, rel).not.toBeNull();
  expect(r!.code.startsWith(src), "the source before the trailer is untouched").toBe(true);
  expect(r!.code.slice(src.length).split("\n").length, "the trailer is one line after a newline").toBe(3);
  return { exports: load(rel, r!.code), fns: r!.fns };
}

describe("wrapped shapes", () => {
  test("exports.X = local / function / arrow, and module.exports.X", () => {
    const src = `"use strict";
function getUser(id) {
  return { id };
}
exports.getUser = getUser;
exports.listUsers = function listUsers() {
  return [];
};
exports.label = (id) => "#" + id;
module.exports.count = function () {
  return 0;
};
`;
    const { exports, fns } = wrapAndLoad("src/a.js", src);
    expect(fns).toBe(4);
    for (const k of ["getUser", "listUsers", "label", "count"]) expect(exports[k].__hoplens, k).toBe(true);
    expect(exports.getUser(3)).toEqual({ id: 3 });
    expect(metas).toEqual([
      { name: "getUser", file: "src/a.js", line: 2 },
      { name: "listUsers", file: "src/a.js", line: 6 },
      { name: "label", file: "src/a.js", line: 9 },
      { name: "count", file: "src/a.js", line: 10 },
    ]);
  });

  test("module.exports = { a, b: fn, c() {} }; a getter in it is never called", () => {
    const src = `let reads = 0;
function find(id) {
  return id;
}
const save = async (x) => x;
module.exports = {
  find,
  store: save,
  inline: function () {
    return 1;
  },
  method() {
    return this.find(2);
  },
  get reads() {
    return ++reads;
  },
  version: 3,
  dep: require("node:path").join,
};
`;
    const { exports, fns } = wrapAndLoad("src/b.js", src);
    expect(fns).toBe(4);
    expect(metas.map((m) => [m.name, m.line])).toEqual([
      ["find", 2],
      ["save", 5],
      ["inline", 9],
      ["method", 12],
    ]);
    expect(exports.method()).toBe(2);
    expect(exports.dep.__hoplens).toBeUndefined();
    // The trailer reads descriptors only: the getter first runs here.
    expect(exports.reads).toBe(1);
  });

  test("tsc's CommonJS output: the void 0 header and `exports.X = X`; re-export getters stay", () => {
    const src = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listUsers = exports.getUser = void 0;
const other_1 = { y: function y() {} };
Object.defineProperty(exports, "y", { enumerable: true, get: function () { return other_1.y; } });
function getUser(id) {
    return { id };
}
exports.getUser = getUser;
const listUsers = () => [];
exports.listUsers = listUsers;
`;
    const { exports, fns } = wrapAndLoad("src/tsc.js", src);
    expect(fns).toBe(2);
    expect(exports.getUser.__hoplens).toBe(true);
    expect(exports.listUsers.__hoplens).toBe(true);
    expect(Object.getOwnPropertyDescriptor(exports, "y")!.get).toBeTypeOf("function");
    expect(exports.y.__hoplens).toBeUndefined();
    expect(exports.__esModule).toBe(true);
  });

  test("Object.defineProperty(exports, X, { value, writable: true }) is wrapped; without writable it is not", () => {
    const src = `"use strict";
function a() {}
function b() {}
Object.defineProperty(exports, "a", { value: a, writable: true, enumerable: true });
Object.defineProperty(exports, "b", { value: b, enumerable: true });
`;
    const { exports, fns } = wrapAndLoad("src/dp.js", src);
    expect(fns).toBe(2);
    expect(exports.a.__hoplens).toBe(true);
    expect(exports.b.__hoplens).toBeUndefined();
    expect(metas.map((m) => m.name)).toEqual(["a"]);
  });

  test("calls through module.exports see the wrapper; calls through the local binding do not", () => {
    const src = `function inner() {
  return 1;
}
function viaExports() {
  return module.exports.inner();
}
function viaLocal() {
  return inner();
}
module.exports = { inner, viaExports, viaLocal };
`;
    const { exports } = wrapAndLoad("src/intra.js", src);
    exports.viaLocal();
    expect(calls).toEqual({ viaLocal: 1 });
    exports.viaExports();
    expect(calls).toEqual({ viaLocal: 1, viaExports: 1, inner: 1 });
  });

  test("TypeScript with export syntax gets the module trailer (the loader compiles the rebinding)", () => {
    const src =
      "export function getUser(id: number) {\n  return id;\n}\nexport const label = (n: number) => `#${n}`;\n";
    const r = transformCommonJS(src, at("src/t.ts"), opts)!;
    expect(r.fns).toBe(2);
    expect(r.code).toContain('getUser = __tpw(getUser, {"name":"getUser","file":"src/t.ts","line":1});');
    expect(r.code.startsWith(src.replace("export const", "export let  "))).toBe(true);
  });
});

describe("never wrapped, never throws", () => {
  test("getter exports (esbuild's __export), frozen and non-writable exports, in strict mode", () => {
    const esbuild = `"use strict";
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var src_exports = {};
__export(src_exports, { getUser: () => getUser });
module.exports = src_exports;
function getUser() {}
`;
    expect(transformCommonJS(esbuild, at("src/esb.js"), opts)).toBeNull();

    const frozen = `"use strict";
function getUser() {}
exports.getUser = getUser;
exports.other = function () {};
Object.freeze(exports);
`;
    const f = wrapAndLoad("src/frozen.js", frozen);
    expect(f.fns).toBe(2);
    expect(f.exports.getUser.__hoplens).toBeUndefined();
    expect(Object.isFrozen(f.exports)).toBe(true);

    const locked = `"use strict";
exports.getUser = function getUser() {};
const e = exports;
Object.defineProperty(e, "getUser", { writable: false, configurable: false });
`;
    const l = wrapAndLoad("src/locked.js", locked);
    expect(l.exports.getUser.__hoplens).toBeUndefined();
    expect(metas).toEqual([]);
  });

  test("module.exports = fn is not wrapped (its function-valued properties are)", () => {
    const src = `module.exports = function main() {
  return 1;
};
module.exports.helper = function helper() {};
`;
    const { exports } = wrapAndLoad("src/main-fn.js", src);
    expect(exports.__hoplens).toBeUndefined();
    expect(exports.helper.__hoplens).toBe(true);
  });

  test("a key the module replaced later, or a module.exports that is not an object, is left alone", () => {
    const later = "exports.a = function () {};\nmodule.exports = { b: 1 };\n";
    expect(wrapAndLoad("src/later.js", later).exports).toEqual({ b: 1 });
    const prim = "exports.a = function () {};\nmodule.exports = 5;\n";
    expect(wrapAndLoad("src/prim.js", prim).exports).toBe(5);
    expect(metas).toEqual([]);
  });

  test("without a wrap on globalThis the trailer does nothing", () => {
    (globalThis as any).__hoplens = undefined;
    const { exports } = wrapAndLoad("src/nowrap.js", "exports.a = function a() {};\n");
    expect(exports.a.__hoplens).toBeUndefined();
  });

  test("skipped shapes: value uses, constructors, generators, defaults, ambiguous keys", () => {
    const src = `function f() {}
bus.on("x", f);
exports.f = f;
exports.h = function () {};
bus.on("y", exports.h);
exports.K = function K() { this.x = 1; };
exports.g = function* () {};
exports.n = 1;
exports.twice = function () {};
exports.twice = function () {};
exports.default = function () {};
exports.req = require("./x");
`;
    expect(transformCommonJS(src, at("src/skip.js"), opts)).toBeNull();
  });

  test("JavaScript with import/export syntax, a parse error, or nothing exported: null", () => {
    expect(transformCommonJS("export function f() {}\n", at("src/esm.js"), opts)).toBeNull();
    expect(transformCommonJS("exports.f = function () {\n", at("src/bad.js"), opts)).toBeNull();
    expect(transformCommonJS("const x = 1;\nconsole.log(x);\n", at("src/plain.js"), opts)).toBeNull();
    expect(transformCommonJS("module.exports = app;\n", at("src/app.js"), opts)).toBeNull();
  });
});

describe("mayHaveCommonJSTargets", () => {
  test("matches the export shapes, not `module.exports = x` or a mention", () => {
    for (const s of [
      "exports.a = f",
      "module.exports.a = f",
      'exports["a"] = f',
      "module.exports = {",
      'Object.defineProperty(exports, "a", {})',
      "export function f() {}",
    ]) {
      expect(mayHaveCommonJSTargets(s), s).toBe(true);
    }
    for (const s of ["module.exports = app;", "// exports", "if (exports.a === f) {}", "const exports2 = 1"]) {
      expect(mayHaveCommonJSTargets(s), s).toBe(false);
    }
  });
});

describe("recursion, aliases, tsc call shapes, type-checking loaders", () => {
  test("a function that recurses through its own export is skipped (recursion depth matches the app)", () => {
    const src = `exports.depth = function (n) {
  return n === 0 ? 0 : 1 + exports.depth(n - 1);
};
function sum(n) {
  return n === 0 ? 0 : n + module.exports.sum(n - 1);
}
module.exports.sum = sum;
exports["walk"] = (n) => (n === 0 ? 0 : (0, exports["walk"])(n - 1));
module.exports.obj = {};
exports.other = function other(n) {
  return exports.depth(n);
};
`;
    const { exports, fns } = wrapAndLoad("src/rec.js", src);
    expect(fns).toBe(1);
    expect(metas.map((m) => m.name)).toEqual(["other"]);
    expect(exports.depth.__hoplens).toBeUndefined();
    expect(exports.sum.__hoplens).toBeUndefined();
    expect(exports.walk.__hoplens).toBeUndefined();
    expect(exports.other(3)).toBe(3);
  });

  test("a method calling itself through this, in module.exports = { ... }, is skipped", () => {
    const src = `module.exports = {
  fact(n) {
    return n <= 1 ? 1 : n * this.fact(n - 1);
  },
  plain() {
    return this.fact(3);
  },
};
`;
    const { exports } = wrapAndLoad("src/meth.js", src);
    expect(metas.map((m) => m.name)).toEqual(["plain"]);
    expect(exports.plain()).toBe(6);
  });

  test("one function exported under two keys gets one wrapper (export identity holds)", () => {
    const src = `exports.alias = exports.alias2 = function alias() {
  return 1;
};
function make() {
  return 2;
}
module.exports.create = make;
module.exports.make = make;
`;
    const { exports } = wrapAndLoad("src/alias.js", src);
    expect(exports.alias.__hoplens).toBe(true);
    expect(exports.alias).toBe(exports.alias2);
    expect(exports.create).toBe(exports.make);
    expect(metas.length).toBe(2);
  });

  test("tsc's `(0, exports.X)(...)` inside the module is a call, not a value use", () => {
    const src = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.square = exports.mul = void 0;
const mul = (a, b) => a * b;
exports.mul = mul;
const square = (x) => (0, exports.mul)(x, x);
exports.square = square;
`;
    const { exports, fns } = wrapAndLoad("src/tscmul.js", src);
    expect(fns).toBe(2);
    expect(exports.mul.__hoplens).toBe(true);
    expect(exports.square(3)).toBe(9);
    expect(calls).toEqual({ square: 1, mul: 1 });
  });

  test("the trailer of a .ts / .cts file type-checks under strict settings (ts-node's default mode)", () => {
    const ts = require("typescript");
    const cases: [string, string][] = [
      [
        "src/things.ts",
        "export function getThing(id: number) {\n  return { id };\n}\nexport const label = (n: number): string => `#${n}`;\n",
      ],
      [
        "src/things2.cts",
        "function getThing(id: number) {\n  return { id };\n}\nexports.getThing = getThing;\nmodule.exports.other = (n: number) => n;\n",
      ],
    ];
    for (const [rel, src] of cases) {
      const r = transformCommonJS(src, at(rel), opts);
      expect(r, rel).not.toBeNull();
      expect(r!.code.startsWith(src.replace("export const", "export let  ")), rel).toBe(true);
      const file = at(rel);
      const options = {
        strict: true,
        noImplicitAny: true,
        noEmit: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        types: ["node"],
        typeRoots: [path.resolve(__dirname, "..", "node_modules", "@types")],
      };
      // What ts-node does without transpileOnly: a full type-check of the source the loader is handed.
      const check = (code: string): string[] => {
        const host = ts.createCompilerHost(options);
        const get = host.getSourceFile;
        host.getSourceFile = (f: string, lang: any, ...rest: any[]) =>
          path.resolve(f) === path.resolve(file)
            ? ts.createSourceFile(f, code, lang, true)
            : get.call(host, f, lang, ...rest);
        const exists = host.fileExists;
        host.fileExists = (f: string) => path.resolve(f) === path.resolve(file) || exists.call(host, f);
        return ts
          .getPreEmitDiagnostics(ts.createProgram([file], options, host))
          .map((d: any) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      };
      expect(check(src), `${rel} plain`).toEqual([]);
      expect(check(r!.code), rel).toEqual([]);
    }
  });
});
