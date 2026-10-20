// The transform cache (src/cache.ts): unit tests on the source, then real `node --import` runs on the
// built dist/ for both threads (ESM hook in the hooks worker, CommonJS layer in the main thread), the
// debug log, and a warm start that loads no TypeScript anywhere.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  CACHE_SCHEMA,
  TransformCache,
  cacheKey,
  cacheSize,
  cached,
  evictCache,
  evictDue,
  fromEdits,
  openCache,
  toEdits,
  transformVersion,
} from "../src/cache";
import { debugLine, transformDebug } from "../src/register";

const DIST = path.resolve(__dirname, "..", "dist");
const REGISTER = path.join(DIST, "register.js");

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const rm = (d: string) => {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
};

describe("edits", () => {
  test("const swaps and the appended text round-trip", () => {
    const src = "export const a = () => 1;\nconst b = 2;\nexport function c() {}\n";
    // `const` -> `let  ` at the same offsets, then a trailer
    const realOut = `${src.slice(0, 7)}let  ${src.slice(12, 26)}let  ${src.slice(31)}TRAILER`;
    const e = toEdits(src, realOut)!;
    expect(e).toEqual({ swaps: [7, 26], suffix: "TRAILER" });
    expect(fromEdits(src, e.swaps, e.suffix)).toBe(realOut);
  });

  test("any other change is not expressible, and a swap off a `const` does not rebuild", () => {
    expect(toEdits("const a = 1;", "const b = 1;")).toBeUndefined();
    expect(toEdits("const a = 1;", "const a")).toBeUndefined();
    expect(fromEdits("let a = 1;", [0], "")).toBeUndefined();
    expect(fromEdits("const a = 1; const b", [0, 2], "")).toBeUndefined();
    expect(fromEdits("const a = 1;", [0.5], "")).toBeUndefined();
  });
});

describe("cache key", () => {
  const o = { root: "/app", include: ["src/**"], exclude: ["src/gen/**"], preset: "node" as const };
  const base = cacheKey("v1", "raw", "/app/src/a.js", "export function a() {}", o);
  test.each([
    ["source bytes", cacheKey("v1", "raw", "/app/src/a.js", "export function a() { }", o)],
    ["transform version", cacheKey("v2", "raw", "/app/src/a.js", "export function a() {}", o)],
    ["mode", cacheKey("v1", "cjs", "/app/src/a.js", "export function a() {}", o)],
    ["path", cacheKey("v1", "raw", "/app/src/b.js", "export function a() {}", o)],
    ["root", cacheKey("v1", "raw", "/app/src/a.js", "export function a() {}", { ...o, root: "/app/src" })],
    ["preset", cacheKey("v1", "raw", "/app/src/a.js", "export function a() {}", { ...o, preset: "next" })],
    ["include", cacheKey("v1", "raw", "/app/src/a.js", "export function a() {}", { ...o, include: ["**"] })],
    ["exclude", cacheKey("v1", "raw", "/app/src/a.js", "export function a() {}", { ...o, exclude: [] })],
    ["raw file (COMPILED)", cacheKey("v1", "raw", "/app/src/a.js", "export function a() {}", o, "raw")],
  ])("changes with the %s", (_what, k) => {
    expect(k).not.toBe(base);
    expect(k).toMatch(/^[0-9a-f]{40}$/);
  });
  test("is stable for the same input", () => {
    expect(cacheKey("v1", "raw", "/app/src/a.js", Buffer.from("export function a() {}"), o)).toBe(base);
  });
});

describe("TransformCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp("hoplens-tcache-");
    return () => rm(dir);
  });
  const src = "export const a = () => 1;\n";
  const code = "export let   a = () => 1;\n;(trailer)\n";

  test("miss, then hit; none and refused round-trip too", () => {
    const c = new TransformCache(dir, "v");
    expect(c.get("k1", src)).toBeUndefined();
    c.set("k1", src, { kind: "wrapped", code, fns: 1 });
    expect(c.get("k1", src)).toEqual({ kind: "wrapped", code, fns: 1 });
    c.set("k2", src, { kind: "none" });
    expect(c.get("k2", src)).toEqual({ kind: "none" });
    c.set("k3", src, { kind: "refused", reason: "x: no" });
    expect(c.get("k3", src)).toEqual({ kind: "refused", reason: "x: no" });
    expect(c.stats).toEqual({ hits: 3, misses: 1, writes: 3 });
    expect(fs.readdirSync(dir).sort()).toEqual(["k1.hlc", "k2.hlc", "k3.hlc"]);
  });

  test("a result that is not swaps + appended text is not stored", () => {
    const c = new TransformCache(dir, "v");
    c.set("k", src, { kind: "wrapped", code: "something else", fns: 1 });
    expect(fs.existsSync(path.join(dir, "k.hlc"))).toBe(false);
  });

  test.each([
    ["corrupt JSON", "{not json"],
    [
      "a partial write",
      JSON.stringify({ v: CACHE_SCHEMA, key: "k", kind: "wrapped", fns: 1, swaps: [7] }).slice(0, 40),
    ],
    ["another schema", JSON.stringify({ v: CACHE_SCHEMA + 1, key: "k", kind: "none" })],
    ["another key (a renamed entry)", JSON.stringify({ v: CACHE_SCHEMA, key: "other", kind: "none" })],
    ["an unknown kind", JSON.stringify({ v: CACHE_SCHEMA, key: "k", kind: "maybe" })],
    ["no suffix", JSON.stringify({ v: CACHE_SCHEMA, key: "k", kind: "wrapped", fns: 1, swaps: [] })],
    ["zero fns", JSON.stringify({ v: CACHE_SCHEMA, key: "k", kind: "wrapped", fns: 0, swaps: [], suffix: "" })],
    [
      "a swap off a const",
      JSON.stringify({ v: CACHE_SCHEMA, key: "k", kind: "wrapped", fns: 1, swaps: [1], suffix: "" }),
    ],
    ["an empty file", ""],
  ])("%s is a miss, and the next store replaces it", (_what, text) => {
    fs.writeFileSync(path.join(dir, "k.hlc"), text);
    const c = new TransformCache(dir, "v");
    expect(c.get("k", src)).toBeUndefined();
    c.set("k", src, { kind: "wrapped", code, fns: 1 });
    expect(c.get("k", src)).toEqual({ kind: "wrapped", code, fns: 1 });
  });

  test("cached() computes once per input and stores nothing for a throw", () => {
    const c = new TransformCache(dir, "v");
    const o = { root: dir, preset: "node" as const };
    let calls = 0;
    const compute = () => {
      calls++;
      return { kind: "wrapped" as const, code, fns: 1 };
    };
    expect(cached(c, "raw", path.join(dir, "a.js"), src, o, compute)).toEqual({
      result: { kind: "wrapped", code, fns: 1 },
      hit: false,
    });
    expect(cached(c, "raw", path.join(dir, "a.js"), src, o, compute)).toEqual({
      result: { kind: "wrapped", code, fns: 1 },
      hit: true,
    });
    expect(calls).toBe(1);
    // A different mode or bytes: computed again.
    cached(c, "cjs", path.join(dir, "a.js"), src, o, compute);
    cached(c, "raw", path.join(dir, "a.js"), `${src} `, o, () => ({ kind: "none" }));
    expect(calls).toBe(2);
    expect(() =>
      cached(c, "raw", path.join(dir, "b.js"), src, o, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(cacheSize(dir).entries).toBe(3);
    // No cache: always computed, no hit field.
    expect(cached(undefined, "raw", path.join(dir, "a.js"), src, o, compute)).toEqual({
      result: { kind: "wrapped", code, fns: 1 },
    });
    expect(calls).toBe(3);
  });

  test("a none computed while TypeScript could not load is not stored", () => {
    const c = new TransformCache(dir, "v");
    const o = { root: dir, preset: "node" as const };
    let ts = false;
    const none = () => ({ kind: "none" as const });
    const f = path.join(dir, "a.js");
    expect(cached(c, "cjs", f, src, o, none, undefined, () => ts)).toEqual({ result: { kind: "none" }, hit: false });
    expect(cacheSize(dir).entries).toBe(0);
    // TypeScript is there on the next start: the parse runs, and its none is kept.
    ts = true;
    expect(cached(c, "cjs", f, src, o, none, undefined, () => ts)).toEqual({ result: { kind: "none" }, hit: false });
    expect(cached(c, "cjs", f, src, o, none, undefined, () => ts)).toEqual({ result: { kind: "none" }, hit: true });
    // A wrapped result proves the parse ran whatever the probe says.
    const w = () => ({ kind: "wrapped" as const, code, fns: 1 });
    cached(c, "raw", f, src, o, w, undefined, () => false);
    expect(cacheSize(dir).entries).toBe(2);
  });

  test("a hit on an entry written over an hour ago moves its mtime (eviction is least recently used)", async () => {
    const c = new TransformCache(dir, "v");
    c.set("k", src, { kind: "wrapped", code, fns: 1 });
    const p = path.join(dir, "k.hlc");
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(p, old, old);
    expect(c.get("k", src)).toEqual({ kind: "wrapped", code, fns: 1 });
    for (let i = 0; i < 50 && fs.statSync(p).mtimeMs < Date.now() - 3600_000; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(fs.statSync(p).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    // A recent entry is not touched (no write per hit).
    const recent = new Date(Date.now() - 600_000);
    fs.utimesSync(p, recent, recent);
    c.get("k", src);
    await new Promise((r) => setTimeout(r, 100));
    expect(Math.abs(fs.statSync(p).mtimeMs - recent.getTime())).toBeLessThan(5);
  });

  test("eviction scans at most once per interval across threads and processes", () => {
    const now = Date.now();
    expect(evictDue(dir, now)).toBe(true);
    expect(evictDue(dir, now + 1000)).toBe(false);
    expect(evictDue(dir, now + 11 * 60_000)).toBe(true);
    // The stamp is no entry.
    expect(cacheSize(dir).entries).toBe(0);
    expect(fs.readdirSync(dir).some((n) => n.endsWith(".json"))).toBe(false);
  });

  test("eviction drops the least recently used entries beyond the limits, and stale temp files", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      const p = path.join(dir, `e${i}.hlc`);
      fs.writeFileSync(p, "x".repeat(100));
      const t = new Date(now - (10 - i) * 60_000);
      fs.utimesSync(p, t, t);
    }
    const stale = path.join(dir, "e0.hlc.123.abc.tmp");
    fs.writeFileSync(stale, "");
    fs.utimesSync(stale, new Date(now - 3600_000), new Date(now - 3600_000));
    const fresh = path.join(dir, "e1.hlc.123.def.tmp");
    fs.writeFileSync(fresh, "");
    expect(await evictCache(dir, { entries: 100, bytes: 100_000 }, now)).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    // Over the count: down to 90% of it, oldest first.
    expect(await evictCache(dir, { entries: 5, bytes: 100_000 }, now)).toBe(6);
    expect(
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".hlc"))
        .sort(),
    ).toEqual(["e6.hlc", "e7.hlc", "e8.hlc", "e9.hlc"]);
    // Over the bytes.
    expect(await evictCache(dir, { entries: 100, bytes: 250 }, now)).toBe(2);
    expect(cacheSize(dir)).toEqual({ entries: 2, bytes: 200 });
    expect(await evictCache(path.join(dir, "missing"))).toBe(0);
  });

  test("the version follows the transform build and the TypeScript package", () => {
    const dist = tmp("hoplens-tver-");
    try {
      expect(transformVersion(dist, dist)).toBeUndefined();
      expect(openCache(dir, dist, dist)).toBeUndefined();
      fs.writeFileSync(path.join(dist, "index.js"), "one");
      const v1 = transformVersion(dist, dist);
      fs.writeFileSync(path.join(dist, "index.js"), "two");
      const v2 = transformVersion(dist, dist);
      expect(v1).toMatch(/^[0-9a-f]{40}$/);
      expect(v2).not.toBe(v1);
      // A project TypeScript (none of our own next to this fake dist): its version is in the key.
      const ts = path.join(dist, "node_modules", "typescript");
      fs.mkdirSync(ts, { recursive: true });
      fs.writeFileSync(path.join(ts, "package.json"), JSON.stringify({ name: "typescript", version: "5.0.0" }));
      const v3 = transformVersion(dist, dist);
      fs.writeFileSync(path.join(ts, "package.json"), JSON.stringify({ name: "typescript", version: "5.9.0" }));
      expect(transformVersion(dist, dist)).not.toBe(v3);
      expect(v3).not.toBe(v2);
    } finally {
      rm(dist);
    }
  });

  test("HOPLENS_TRANSFORM_CACHE=0 turns it off", () => {
    const prev = process.env.HOPLENS_TRANSFORM_CACHE;
    try {
      process.env.HOPLENS_TRANSFORM_CACHE = "0";
      expect(openCache(dir, DIST, dir)).toBeUndefined();
      process.env.HOPLENS_TRANSFORM_CACHE = "1";
      expect(openCache(dir, DIST, dir)).toBeInstanceOf(TransformCache);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "HOPLENS_TRANSFORM_CACHE");
      else process.env.HOPLENS_TRANSFORM_CACHE = prev;
    }
  });
});

describe("debug log", () => {
  test("HOPLENS_DEBUG names transform", () => {
    expect(transformDebug({})).toBe(false);
    expect(transformDebug({ HOPLENS_DEBUG: "0" })).toBe(false);
    expect(transformDebug({ HOPLENS_DEBUG: "routes" })).toBe(false);
    expect(transformDebug({ HOPLENS_DEBUG: "transform" })).toBe(true);
    expect(transformDebug({ HOPLENS_DEBUG: "routes, transform" })).toBe(true);
    expect(transformDebug({ HOPLENS_DEBUG: "1" })).toBe(true);
    expect(transformDebug({ HOPLENS_DEBUG: "*" })).toBe(true);
  });

  test("one line per file: outcome, mode, cache, TypeScript load, time", () => {
    expect(debugLine({ type: "wrapped", file: "src/a.ts", fns: 2, mode: "raw", cache: "hit", ms: 0.26 })).toBe(
      "hoplens:transform src/a.ts mode=raw wrapped=2 cache=hit 0.3ms",
    );
    expect(debugLine({ type: "none", file: "src/b.js", mode: "cjs", cache: "miss", ts: "main", ms: 31 })).toBe(
      "hoplens:transform src/b.js mode=cjs none cache=miss ts=loaded(main) 31.0ms",
    );
    expect(
      debugLine({ type: "refused", file: "src/c.ts", reason: "unmapped", detail: "f: nope", mode: "compiled" }),
    ).toBe(
      "hoplens:transform src/c.ts mode=compiled refused=unmapped (the compiled output does not map back to the source: f: nope)",
    );
    expect(debugLine({ type: "refused", file: "src/d.cjs", reason: "esm-loader" })).toBe(
      "hoplens:transform src/d.cjs refused=esm-loader (CommonJS Node read through its ESM loader)",
    );
    expect(debugLine({ type: "error", file: "src/e.js", message: "bad\nthing" })).toBe(
      'hoplens:transform src/e.js error="bad\\nthing"',
    );
  });
});

// ── both threads, through real node processes ─────────────────────────────
describe("warm start (both threads)", () => {
  let root: string;
  const cacheDir = () => path.join(root, "state", "transform");

  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  beforeAll(() => {
    if (!fs.existsSync(path.join(DIST, "hooks.mjs"))) throw new Error("build @hoplens/transform first (pnpm build)");
    root = tmp("hoplens-tcache-run-");
    write("package.json", JSON.stringify({ name: "fx", private: true }));
    write(
      "preload.cjs",
      `const { register } = require(${JSON.stringify(REGISTER)});
globalThis.__wrapped = [];
globalThis.__hoplens = { wrap(fn, meta) { globalThis.__wrapped.push(meta); const w = function (...a) { return fn.apply(this, a); }; w.__hoplens = true; return w; } };
const o = JSON.parse(process.env.FX_OPTS || "{}");
register({ root: process.env.FX_ROOT, include: o.include || ["src/**"], preset: "node", cacheDir: o.cacheDir });
`,
    );
    write("src/esm.mjs", "export const e = () => 'e';\nexport function f() {\n  return 'f';\n}\n");
    write("src/none.mjs", "export const x = 1;\n");
    write("src/old.cjs", "exports.c = function c() {\n  return 'c';\n};\n");
    write(
      "src/main.mjs",
      `import { createRequire } from "node:module";
import { e, f } from "./esm.mjs";
import { x } from "./none.mjs";
const require = createRequire(import.meta.url);
const { c } = require("./old.cjs");
console.log(JSON.stringify({
  values: [e(), f(), x, c()],
  marked: [Boolean(e.__hoplens), Boolean(f.__hoplens), Boolean(c.__hoplens)],
  wrapped: globalThis.__wrapped,
  mainTs: Object.keys(require.cache).some((k) => /[\\\\/]typescript[\\\\/]/.test(k)),
}));
`,
    );
  });
  afterAll(() => rm(root));

  function start(env: Record<string, string> = {}, opts: Record<string, unknown> = { cacheDir: cacheDir() }) {
    const e: NodeJS.ProcessEnv = { ...process.env, FX_ROOT: root, FX_OPTS: JSON.stringify(opts), ...env };
    for (const k of Object.keys(e)) if (k.startsWith("VITEST") || k === "NODE_OPTIONS") delete e[k];
    if (!("HOPLENS_DEBUG" in env)) e.HOPLENS_DEBUG = "transform";
    if (!("HOPLENS_TRANSFORM_CACHE" in env)) Reflect.deleteProperty(e, "HOPLENS_TRANSFORM_CACHE");
    const r = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(path.join(root, "preload.cjs")).href, "src/main.mjs"],
      { cwd: root, env: e, encoding: "utf8", timeout: 30000 },
    );
    const lines = r.stderr.split(/\r?\n/).filter((l) => l.startsWith("hoplens:transform "));
    const line = (file: string) => lines.find((l) => l.startsWith(`hoplens:transform ${file} `)) ?? "";
    return { r, out: JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!), lines, line };
  }

  const EXPECTED = {
    values: ["e", "f", 1, "c"],
    marked: [true, true, true],
    wrapped: [
      { name: "e", file: "src/esm.mjs", line: 1 },
      { name: "f", file: "src/esm.mjs", line: 2 },
      { name: "c", file: "src/old.cjs", line: 1 },
    ],
  };

  test("cold start parses and stores; a warm start answers every file from the cache and loads no TypeScript", () => {
    rm(cacheDir());
    const cold = start();
    expect(cold.r.status).toBe(0);
    expect(cold.out).toMatchObject(EXPECTED);
    expect(cold.out.mainTs).toBe(true);
    // The debug log is on stderr only, one line per file.
    expect(cold.r.stdout).not.toContain("hoplens:transform");
    expect(cold.line("src/esm.mjs")).toMatch(
      /^hoplens:transform src\/esm\.mjs mode=raw wrapped=2 cache=miss ts=loaded\(hooks\) \d+\.\dms$/,
    );
    expect(cold.line("src/none.mjs")).toMatch(/^hoplens:transform src\/none\.mjs mode=raw none cache=miss \d+\.\dms$/);
    expect(cold.line("src/old.cjs")).toMatch(
      /^hoplens:transform src\/old\.cjs mode=cjs wrapped=1 cache=miss ts=loaded\(main\) \d+\.\dms$/,
    );
    // No `export` token at all: ruled out by the prescan, never hashed, parsed or logged.
    expect(cold.line("src/main.mjs")).toBe("");
    expect(cacheSize(cacheDir()).entries).toBe(3);

    const warm = start();
    expect(warm.r.status).toBe(0);
    expect(warm.out).toMatchObject(EXPECTED);
    expect(warm.out.mainTs).toBe(false);
    expect(warm.lines).toHaveLength(3);
    for (const l of warm.lines) {
      expect(l).toContain("cache=hit");
      expect(l).not.toContain("ts=loaded");
    }
  });

  test("an edit invalidates that file only; other options invalidate all; a corrupt entry is recomputed", () => {
    start();
    write("src/esm.mjs", "export const e = () => 'e';\nexport function f() {\n  return 'f';\n}\n// edited\n");
    const edited = start();
    expect(edited.out).toMatchObject(EXPECTED);
    expect(edited.line("src/esm.mjs")).toContain("wrapped=2 cache=miss");
    expect(edited.line("src/old.cjs")).toContain("cache=hit");
    // Another include: a different key for every file.
    const wider = start({}, { cacheDir: cacheDir(), include: ["src/**", "lib/**"] });
    for (const l of wider.lines) expect(l).toContain("cache=miss");
    // Corrupt every entry: all recomputed, same result.
    for (const f of fs.readdirSync(cacheDir())) fs.writeFileSync(path.join(cacheDir(), f), "{");
    const fixed = start();
    expect(fixed.out).toMatchObject(EXPECTED);
    for (const l of fixed.lines) expect(l).toContain("cache=miss");
    expect(start().lines.every((l) => l.includes("cache=hit"))).toBe(true);
  });

  test("flushReports: the callback runs after the hook's reports so far arrived (warm: they cost no parse)", () => {
    write(
      "flush.mjs",
      `import { createRequire } from "node:module";
import { e } from "./src/esm.mjs";
const { flushReports } = createRequire(import.meta.url)(${JSON.stringify(REGISTER)});
const before = globalThis.__seen.length;
flushReports(() => console.log(JSON.stringify({ before, after: globalThis.__seen.slice(), wrapped: Boolean(e.__hoplens) })));
`,
    );
    const pre = path.join(root, "preload-seen.cjs");
    fs.writeFileSync(
      pre,
      `globalThis.__seen = [];
const { register } = require(${JSON.stringify(REGISTER)});
globalThis.__hoplens = { wrap(fn) { const w = function (...a) { return fn.apply(this, a); }; w.__hoplens = true; return w; } };
register({ root: process.env.FX_ROOT, include: ["src/**"], preset: "node", cacheDir: process.env.FX_CACHE, onReport: (r) => globalThis.__seen.push(r.file) });
`,
    );
    const env: NodeJS.ProcessEnv = { ...process.env, FX_ROOT: root, FX_CACHE: cacheDir() };
    for (const k of Object.keys(env))
      if (k.startsWith("VITEST") || k.startsWith("HOPLENS") || k === "NODE_OPTIONS") delete env[k];
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, ["-r", pre, "flush.mjs"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30000,
      });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);
      expect(out.wrapped).toBe(true);
      expect(out.after).toContain("src/esm.mjs");
    }
    // No hook registered: right away.
    const r = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(REGISTER)}).flushReports(() => console.log("now"))`],
      { cwd: root, env, encoding: "utf8", timeout: 30000 },
    );
    expect(r.stdout.trim()).toBe("now");
  });

  test("HOPLENS_TRANSFORM_CACHE=0, or no cacheDir: no cache, same result; no debug log without HOPLENS_DEBUG", () => {
    rm(cacheDir());
    const off = start({ HOPLENS_TRANSFORM_CACHE: "0" });
    expect(off.out).toMatchObject(EXPECTED);
    expect(off.lines.length).toBe(3);
    for (const l of off.lines) expect(l).not.toContain("cache=");
    expect(fs.existsSync(cacheDir())).toBe(false);
    const none = start({}, {});
    expect(none.out).toMatchObject(EXPECTED);
    expect(fs.existsSync(cacheDir())).toBe(false);
    const quiet = start({ HOPLENS_DEBUG: "" });
    expect(quiet.out).toMatchObject(EXPECTED);
    expect(quiet.r.stderr).toBe("");
  });
});
