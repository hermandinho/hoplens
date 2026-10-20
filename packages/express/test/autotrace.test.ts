// The pre-boot function shim, readAutoTrace, the default scope and the banner lines, in process.
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FALLBACK_DIRS as CORE_FALLBACK_DIRS } from "../../core/src/sourcewatch";
import {
  DEV_STACK_TRACE_LIMIT,
  FALLBACK_DIRS,
  bindFnShim,
  defaultInclude,
  installShim,
  isReqResCall,
  raiseStackTraceLimit,
  readAutoTrace,
  transformCacheDir,
} from "../src/autotrace";
import { bannerText, functionHopsLine, refusedNote } from "../src/banner";
import { resolveOptions } from "../src/options";
import { adapterState } from "../src/state";
import { makeFixture } from "./helpers";

const G = globalThis as any;
const KEY = Symbol.for("hoplens.express.fnshim");
const META = { name: "f", file: "src/f.js", line: 3 };

function reset() {
  Reflect.deleteProperty(G, "__hoplens");
  Reflect.deleteProperty(G, KEY);
}

/** What Runtime.start() does: replace the global with core's wrap. `calls` counts real wraps. */
function fakeBoot() {
  const calls: Array<{ fn: any; meta: any }> = [];
  const spans: string[] = [];
  const wrap = (fn: any, meta: any) => {
    calls.push({ fn, meta });
    const w = function (this: any, ...args: any[]) {
      spans.push(meta.name);
      return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
    };
    (w as any).__hoplens = true;
    return w;
  };
  const emitDb = () => {};
  G.__hoplens = { wrap, emitDb, version: 2 };
  return { calls, spans, wrap, emitDb };
}

/** A real IncomingMessage / ServerResponse pair, like the ones Express hands a handler. */
function reqRes() {
  const req = new http.IncomingMessage(new net.Socket());
  const res = new http.ServerResponse(req);
  return { req, res };
}

afterEach(reset);

describe("installShim", () => {
  test("sets the global only when unset", () => {
    expect(installShim()).toBe(true);
    expect(G.__hoplens.shim).toBe(true);
    expect(typeof G.__hoplens.wrap).toBe("function");
    expect(installShim()).toBe(false);
    reset();
    G.__hoplens = { wrap: () => {}, version: 2 };
    const before = G.__hoplens;
    expect(installShim()).toBe(false);
    expect(G.__hoplens).toBe(before);
  });
});

describe("shim wrap", () => {
  test("passes through before boot, binds exactly once after it", () => {
    installShim();
    const fn = vi.fn((a: number, b: number) => a + b);
    const w = G.__hoplens.wrap(fn, META);
    expect(w).not.toBe(fn);
    expect(w(1, 2)).toBe(3);
    expect(bindFnShim()).toBe(false); // nothing to bind: still the shim
    const boot = fakeBoot();
    expect(bindFnShim()).toBe(true);
    expect(bindFnShim()).toBe(false);
    expect(w(2, 3)).toBe(5);
    expect(w(3, 4)).toBe(7);
    expect(boot.calls).toHaveLength(1);
    expect(boot.calls[0]!.fn).toBe(fn);
    expect(boot.calls[0]!.meta).toEqual(META);
    expect(boot.spans).toEqual(["f", "f"]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("after bindFnShim, wraps made post-boot go through the guard; emitDb and version are kept", () => {
    installShim();
    const boot = fakeBoot();
    bindFnShim();
    expect(G.__hoplens.emitDb).toBe(boot.emitDb);
    expect(G.__hoplens.version).toBe(2);
    expect(G.__hoplens.wrap).not.toBe(boot.wrap);
    const late = G.__hoplens.wrap((x: number) => x * 2, { ...META, name: "late" });
    expect(late(4)).toBe(8);
    const { req, res } = reqRes();
    late(req, res);
    expect(boot.spans).toEqual(["late"]);
  });

  test("keeps name, length (4-arity stays 4), prototype, own props, toString and new", () => {
    installShim();
    function handler(_err: unknown, _req: unknown, _res: unknown, _next: unknown) {
      return 1;
    }
    (handler as any).custom = "x";
    const w = G.__hoplens.wrap(handler, META);
    expect(w.name).toBe("handler");
    expect(w.length).toBe(4);
    expect(w.prototype).toBe(handler.prototype);
    expect(w.custom).toBe("x");
    expect(w.toString()).toBe(handler.toString());
    expect(w.__hoplens).toBe(true);
    expect(G.__hoplens.wrap(w, META)).toBe(w);

    function Point(this: any, x: number) {
      this.x = x;
    }
    Point.prototype.get = function (this: any) {
      return this.x;
    };
    const P = G.__hoplens.wrap(Point, META);
    const before = new P(1);
    expect(before.get()).toBe(1);
    expect(before).toBeInstanceOf(Point);
    fakeBoot();
    bindFnShim();
    const after = new P(2);
    expect(after.get()).toBe(2);
    expect(after).toBeInstanceOf(Point);
    expect(G.__hoplens.wrap(42, META)).toBe(42);
  });

  test("(req, res, next) and (err, req, res, next) calls open no span", () => {
    installShim();
    const mw = vi.fn((_req: unknown, _res: unknown, next?: () => void) => next?.());
    const onError = vi.fn((_err: unknown, _req: unknown, _res: unknown, _next: unknown) => "handled");
    const wMw = G.__hoplens.wrap(mw, { ...META, name: "mw" });
    const wErr = G.__hoplens.wrap(onError, { ...META, name: "onError" });
    const boot = fakeBoot();
    bindFnShim();
    const { req, res } = reqRes();
    const next = vi.fn();
    wMw(req, res, next);
    wMw(req, res);
    expect(wErr(new Error("x"), req, res, next)).toBe("handled");
    expect(mw).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledTimes(1);
    expect(boot.calls).toHaveLength(0);
    expect(boot.spans).toEqual([]);
    // Not request-shaped: traced.
    wMw({}, {});
    expect(boot.spans).toEqual(["mw"]);
  });

  test("traced() (line 0) is not guarded: a (req, res) helper wrapped by hand gets its hop", () => {
    installShim();
    const boot = fakeBoot();
    bindFnShim();
    const helper = G.__hoplens.wrap((_req: unknown, _res: unknown) => "ok", {
      name: "helper",
      file: "a.js:3",
      line: 0,
    });
    const { req, res } = reqRes();
    expect(helper(req, res)).toBe("ok");
    expect(boot.spans).toEqual(["helper"]);
  });

  test("a throwing core wrap leaves the original running", () => {
    installShim();
    const w = G.__hoplens.wrap(() => "ok", META);
    G.__hoplens = {
      wrap: () => {
        throw new Error("nope");
      },
      version: 2,
    };
    bindFnShim();
    expect(w()).toBe("ok");
    expect(w()).toBe("ok");
  });
});

describe("re-entrant calls", () => {
  /** What the transform trailer does: the module's own binding becomes the forwarder. */
  function recursive() {
    let depth: (n: number) => number = (n) => (n === 0 ? 0 : 1 + depth(n - 1));
    depth = G.__hoplens.wrap(depth, { ...META, name: "depth" });
    return (n: number) => depth(n);
  }

  /** A core-like wrap that puts several frames between the forwarder and the function. */
  function heavyBoot(frames = 8) {
    const spans: string[] = [];
    G.__hoplens = {
      wrap: (fn: any, meta: any) =>
        function (this: any, ...args: any[]) {
          spans.push(meta.name);
          const nest = (k: number): any => (k === 0 ? fn.apply(this, args) : nest(k - 1));
          return nest(frames);
        },
      version: 2,
    };
    return spans;
  }

  test("a recursive function opens one span, not one per level", () => {
    installShim();
    const depth = recursive();
    const boot = fakeBoot();
    bindFnShim();
    expect(depth(5)).toBe(5);
    expect(boot.spans).toEqual(["depth"]);
    expect(depth(3)).toBe(3);
    expect(boot.spans).toEqual(["depth", "depth"]);
  });

  /** The deepest n for which f(n) returns. */
  function maxDepth(f: (n: number) => number): number {
    let lo = 1;
    let hi = 200000;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      try {
        f(m);
        lo = m;
      } catch {
        hi = m - 1;
      }
    }
    return lo;
  }

  test("recursion keeps most of its unwrapped depth, at boot and after (one extra frame per level)", () => {
    const plain = (n: number): number => (n === 0 ? 0 : 1 + plain(n - 1));
    const base = maxDepth((n) => plain(n));
    installShim();
    const depth = recursive();
    const atBoot = maxDepth(depth);
    heavyBoot();
    bindFnShim();
    const after = maxDepth(depth);
    expect(atBoot / base, `${atBoot} of ${base}`).toBeGreaterThan(0.3);
    expect(after / base, `${after} of ${base}`).toBeGreaterThan(0.3);
  });

  test("mutual recursion and a throw inside it leave later calls traced", () => {
    installShim();
    let even: (n: number) => boolean = (n) => (n === 0 ? true : odd(n - 1));
    let odd: (n: number) => boolean = (n) => {
      if (n === 999) throw new Error("odd 999");
      return n === 0 ? false : even(n - 1);
    };
    even = G.__hoplens.wrap(even, { ...META, name: "even" });
    odd = G.__hoplens.wrap(odd, { ...META, name: "odd" });
    const boot = fakeBoot();
    bindFnShim();
    expect(even(10)).toBe(true);
    expect(boot.spans).toEqual(["even", "odd"]);
    expect(() => even(1000)).toThrow("odd 999");
    expect(even(2)).toBe(true);
    expect(boot.spans).toEqual(["even", "odd", "even", "odd", "even", "odd"]);
  });
});

describe("raiseStackTraceLimit", () => {
  test("raises Node's default 10 so wrapper frames do not push the caller out; leaves a chosen limit alone", () => {
    const before = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 10;
      expect(raiseStackTraceLimit()).toBe(true);
      expect(Error.stackTraceLimit).toBe(DEV_STACK_TRACE_LIMIT);
      expect(DEV_STACK_TRACE_LIMIT).toBeGreaterThanOrEqual(30);
      for (const chosen of [25, 0, Number.POSITIVE_INFINITY]) {
        Error.stackTraceLimit = chosen;
        expect(raiseStackTraceLimit()).toBe(false);
        expect(Error.stackTraceLimit).toBe(chosen);
      }
    } finally {
      Error.stackTraceLimit = before;
    }
  });
});

describe("isReqResCall", () => {
  test("only IncomingMessage/ServerResponse at 0/1 or 1/2", () => {
    const { req, res } = reqRes();
    expect(isReqResCall([req, res])).toBe(true);
    expect(isReqResCall([req, res, () => {}])).toBe(true);
    expect(isReqResCall([new Error("x"), req, res, () => {}])).toBe(true);
    expect(isReqResCall([req])).toBe(false);
    expect(isReqResCall([res, req])).toBe(false);
    expect(isReqResCall([{ url: "/" }, { end() {} }])).toBe(false);
    expect(isReqResCall([1, req, {}])).toBe(false);
  });
});

describe("transformCacheDir", () => {
  const root = path.resolve("/app");
  test.each([
    [{}, path.join(root, "node_modules", ".cache", "hoplens", "transform")],
    [{ HOPLENS_OPTIONS: '{"stateDir":".state"}' }, path.join(root, ".state", "transform")],
    [{ HOPLENS_OPTIONS: '{"root":"sub","stateDir":"s"}' }, path.join(root, "sub", "s", "transform")],
    [{ HOPLENS_OPTIONS: "{bad" }, path.join(root, "node_modules", ".cache", "hoplens", "transform")],
    [{ HOPLENS_OPTIONS: '{"transformCache":false}' }, undefined],
    [{ HOPLENS_OPTIONS: '{"enabled":false}' }, undefined],
    [{ HOPLENS_TRANSFORM_CACHE: "0" }, undefined],
    [{ HOPLENS_TRANSFORM_CACHE: "off" }, undefined],
    [{ HOPLENS_TRANSFORM_CACHE: "1" }, path.join(root, "node_modules", ".cache", "hoplens", "transform")],
  ])("%j -> %s", (env, want) => {
    expect(transformCacheDir(env, root)).toBe(want);
  });
});

describe("readAutoTrace", () => {
  test.each([
    [{}, { on: true, source: "default" }],
    [{ HOPLENS_AUTOTRACE: "0" }, { on: false, source: "HOPLENS_AUTOTRACE" }],
    [{ HOPLENS_AUTOTRACE: "false" }, { on: false, source: "HOPLENS_AUTOTRACE" }],
    [{ HOPLENS_AUTOTRACE: "1" }, { on: true, source: "default" }],
    [{ HOPLENS_OPTIONS: '{"autoTrace":false}' }, { on: false, source: "HOPLENS_OPTIONS" }],
    [{ HOPLENS_OPTIONS: '{"enabled":false}' }, { on: false, source: "HOPLENS_OPTIONS" }],
    [{ HOPLENS_OPTIONS: '{"autoTrace":true}' }, { on: true, source: "HOPLENS_OPTIONS" }],
    [
      { HOPLENS_OPTIONS: '{"autoTrace":{"include":["lib/**"],"exclude":["lib/x.js", 3]}}' },
      { on: true, source: "HOPLENS_OPTIONS", include: ["lib/**"], exclude: ["lib/x.js"] },
    ],
    [{ HOPLENS_OPTIONS: "{bad json" }, { on: true, source: "default" }],
    [
      { HOPLENS_OPTIONS: '{"autoTrace":true}', HOPLENS_AUTOTRACE: "0" },
      { on: false, source: "HOPLENS_AUTOTRACE" },
    ],
  ])("%j", (env, expected) => {
    expect(readAutoTrace(env)).toEqual(expected);
  });

  test("resolveOptions: HOPLENS_AUTOTRACE=0 turns autoTrace off; a code-level autoTrace hints once", () => {
    expect(resolveOptions(undefined, { HOPLENS_AUTOTRACE: "0" }).autoTrace).toBe(false);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      adapterState().autoTraceHinted = false;
      resolveOptions({ autoTrace: false }, {});
      resolveOptions({ autoTrace: false }, {});
      resolveOptions({ autoTrace: true }, {});
      const hints = write.mock.calls.filter((c) => String(c[0]).includes("HOPLENS_OPTIONS"));
      expect(hints).toHaveLength(1);
    } finally {
      write.mockRestore();
    }
  });
});

describe("default scope", () => {
  test("FALLBACK_DIRS mirrors core's", () => {
    expect(FALLBACK_DIRS).toEqual(CORE_FALLBACK_DIRS);
  });

  test("src/ when present, else the fallback dirs present, else nothing", () => {
    const a = makeFixture(undefined, { "src/a.js": "", "lib/b.js": "" });
    const b = makeFixture(undefined, { "lib/b.js": "", "routes/r.js": "", "other/x.js": "" });
    const c = makeFixture(undefined, { "server.js": "" });
    try {
      expect(defaultInclude(a.root)).toEqual(["src/**"]);
      expect(defaultInclude(b.root)).toEqual(["lib/**", "routes/**"]);
      expect(defaultInclude(c.root)).toEqual([]);
      expect(defaultInclude(path.join(c.root, "missing"))).toEqual([]);
    } finally {
      a.cleanup();
      b.cleanup();
      c.cleanup();
    }
  });
});

describe("banner lines", () => {
  test("HOPLENS_DEBUG: the cache count on the hops line, and no debug-log hint on the refusal note", () => {
    const st = { files: 3, fns: 5, refused: { large: 1 }, errors: 0 };
    expect(functionHopsLine({ ...st, cacheDir: "/x", cacheHits: 2 }, {})).toBe("function hops: 5 fns in 3 files");
    expect(functionHopsLine({ ...st, cacheDir: "/x", cacheHits: 2 }, { HOPLENS_DEBUG: "transform" })).toBe(
      "function hops: 5 fns in 3 files (cache: 2 hits)",
    );
    expect(functionHopsLine({ ...st, cacheDir: "/x", cacheHits: 1 }, { HOPLENS_DEBUG: "1" })).toBe(
      "function hops: 5 fns in 3 files (cache: 1 hit)",
    );
    expect(functionHopsLine({ ...st, cacheDir: "/x" }, { HOPLENS_DEBUG: "routes" })).toBe(
      "function hops: 5 fns in 3 files (cache: 0 hits)",
    );
    expect(functionHopsLine(st, { HOPLENS_DEBUG: "transform" })).toBe("function hops: 5 fns in 3 files (cache: off)");
    expect(functionHopsLine({ ...st, cacheDir: "/x", cacheHits: 2 }, { HOPLENS_DEBUG: "0" })).toBe(
      "function hops: 5 fns in 3 files",
    );
    expect(refusedNote(st, {})).toMatch(/not parsed \(HOPLENS_DEBUG=transform lists each file and why\)$/);
    expect(refusedNote(st, { HOPLENS_DEBUG: "transform" })).toMatch(/not parsed$/);
    expect(refusedNote(st, { HOPLENS_DEBUG: "routes,transform" })).toMatch(/not parsed$/);
    expect(refusedNote(st, { HOPLENS_DEBUG: "routes" })).toMatch(/why\)$/);
  });

  test("function hops count and the refusal note", () => {
    expect(functionHopsLine({ files: 0, fns: 0, refused: {}, errors: 0 })).toBeUndefined();
    expect(functionHopsLine({ files: 1, fns: 1, refused: {}, errors: 0 })).toBe("function hops: 1 fn in 1 file");
    expect(functionHopsLine({ files: 3, fns: 5, refused: {}, errors: 0 })).toBe("function hops: 5 fns in 3 files");
    expect(refusedNote({ files: 0, fns: 0, refused: {}, errors: 0 })).toBeUndefined();
    const note = refusedNote({ files: 0, fns: 0, refused: { compiled: 2, commonjs: 1 }, errors: 0 })!;
    expect(note).toContain("2 files compiled by another loader");
    expect(note).toContain("node --import hoplens/express/register --import tsx");
    expect(note).toContain("1 CommonJS file another loader compiled for Node's ESM loader");
    expect(note.includes("\n")).toBe(false);
    const viaEsm = refusedNote({
      files: 0,
      fns: 0,
      refused: { "esm-loader": 2 },
      firstRefused: { "esm-loader": { file: "src/legacy.cjs" } },
      errors: 0,
    })!;
    expect(viaEsm).toBe(
      "function hops skipped for 2 CommonJS files Node loaded through its ESM loader (src/legacy.cjs, ...), as it does for the entry under --import and for a CommonJS file imported from ESM; for a CommonJS entry, preload with -r hoplens/express/register instead of --import (HOPLENS_DEBUG=transform lists each file and why)",
    );
    const large = refusedNote({ files: 0, fns: 0, refused: { large: 1 }, errors: 0 })!;
    expect(large).toBe(
      "function hops skipped for 1 file over 1 MB (generated code?), not parsed (HOPLENS_DEBUG=transform lists each file and why)",
    );
    const one = refusedNote({
      files: 0,
      fns: 0,
      refused: { unmapped: 1 },
      firstRefused: { unmapped: { file: "src/a.ts", detail: "f: not a local export of the compiled source" } },
      errors: 0,
    })!;
    expect(one).toBe(
      "function hops skipped for 1 TypeScript file whose compiled output (tsx?) Hoplens could not map back to the source (src/a.ts: f: not a local export of the compiled source); to wrap it, load Hoplens first: node --import hoplens/express/register --import tsx <entry> (HOPLENS_DEBUG=transform lists each file and why)",
    );
    const two = refusedNote({
      files: 0,
      fns: 0,
      refused: { unmapped: 2 },
      firstRefused: { unmapped: { file: "src/a.ts" } },
      errors: 0,
    })!;
    expect(two).toContain(
      "2 TypeScript files whose compiled output (tsx?) Hoplens could not map back to the source (src/a.ts, ...); to wrap them,",
    );
    const text = bannerText(4983, 3001, [note], ["function hops: 1 fn in 1 file"]);
    expect(text).toContain(
      "(also http://127.0.0.1:4983)\n   function hops: 1 fn in 1 file\n   ! function hops skipped",
    );
  });
});
