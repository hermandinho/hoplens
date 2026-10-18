// register()'s CommonJS layer, through real `node -r` / `--import` child processes on the built dist/:
// the self-healing Module._extensions wrapper and the fs.readFileSync swap scoped to one file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const DIST = path.resolve(__dirname, "..", "dist");
const REGISTER = path.join(DIST, "register.js");

let root: string;

/**
 * Runs before register(): remembers the originals and puts a spy on fs.readFileSync that records what
 * every read returned, so a test can tell whether a read outside the one swapped file saw the disk.
 */
const BEFORE = `
const fs = require("node:fs");
const Module = require("node:module");
globalThis.__orig = { read: fs.readFileSync, js: Module._extensions[".js"], load: Module._load };
const disk = fs.readFileSync;
globalThis.__spyLog = [];
fs.readFileSync = function spy(p, o) {
  const r = disk.apply(this, arguments);
  globalThis.__spyLog.push({ p: String(p), str: typeof r === "string" });
  return r;
};
globalThis.__spy = fs.readFileSync;
`;

const REGISTER_CALL = `
const { register } = require(${JSON.stringify(REGISTER)});
globalThis.__reports = [];
globalThis.__wrapped = [];
globalThis.__hoplens = { wrap(fn, meta) { globalThis.__wrapped.push(meta); const w = function (...a) { return fn.apply(this, a); }; w.__hoplens = true; return w; } };
const opts = { root: process.env.FX_ROOT, include: ["src/**"], onReport: (r) => globalThis.__reports.push(r) };
globalThis.__dispose = register(opts);
register(opts);
`;

/** The app: an in-scope module that reads other files while its body runs, and what main saw. */
const SVC = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const disk = (rel) => globalThis.__orig ? globalThis.__orig.read(path.join(__dirname, "..", rel), "utf8") : "";
// Reads during this module's own load: another file as a string and as a Buffer, and an out-of-scope
// module through require (Node reads it with the same fs.readFileSync).
exports.during = {
  data: fs.readFileSync(path.join(__dirname, "..", "data.txt"), "utf8") === disk("data.txt"),
  buffer: fs.readFileSync(path.join(__dirname, "..", "lib", "other.js")).equals(Buffer.from(disk("lib/other.js"))),
  outside: require("../lib/other.js").other() === "other",
};
function getUser(id) {
  return { id };
}
exports.getUser = getUser;
exports.label = (id) => "#" + id;
`;

const MAIN = `const fs = require("node:fs");
const Module = require("node:module");
const svc = require("./svc");
const out = { wrapped: globalThis.__wrapped, during: svc.during, user: svc.getUser(1), marked: Boolean(svc.getUser.__hoplens) };
// A module that throws while it loads: the swap is gone afterwards, and the error is the module's own.
try { require("./throws"); } catch (e) { out.thrown = e.message; }
out.afterThrow = { read: fs.readFileSync === (globalThis.__spy || globalThis.__orig?.read), data: fs.readFileSync(require("node:path").join(__dirname, "..", "data.txt"), "utf8") };
// require.cache keeps exactly the entries Node makes.
const key = require.resolve("./svc");
out.cache = { has: Boolean(require.cache[key]), same: require.cache[key] && require.cache[key].exports === svc };
out.cacheKeys = Object.keys(require.cache).filter((k) => /[\\\\/](src|lib)[\\\\/]/.test(k) && k.startsWith(process.env.FX_ROOT)).map((k) => require("node:path").relative(process.env.FX_ROOT, k).split("\\\\").join("/")).sort();
// A re-require after a cache delete loads (and wraps) again.
delete require.cache[key];
out.again = Boolean(require("./svc").getUser.__hoplens);
out.extIsOrig = globalThis.__orig ? Module._extensions[".js"] === globalThis.__orig.js : null;
out.readIsSpy = globalThis.__spy ? fs.readFileSync === globalThis.__spy : null;
out.reports = globalThis.__reports;
console.log(JSON.stringify(out));
`;

function node(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const e: NodeJS.ProcessEnv = { ...process.env, FX_ROOT: root, ...env };
  for (const k of Object.keys(e)) if (k.startsWith("VITEST") || k === "NODE_OPTIONS") delete e[k];
  const r = spawnSync(process.execPath, args, { cwd: root, env: e, encoding: "utf8", timeout: 30000 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function write(rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const parse = (stdout: string) => JSON.parse(stdout.trim().split(/\r?\n/).pop()!);
const file = (name: string) => path.join(root, name);

beforeAll(() => {
  if (!fs.existsSync(REGISTER)) throw new Error("build @hoplens/transform first (pnpm build)");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-cjs-")));
  write("package.json", JSON.stringify({ name: "cjs-fixture", private: true }));
  write("before.cjs", BEFORE);
  write("preload.cjs", REGISTER_CALL);
  write("both.cjs", `${BEFORE}\n${REGISTER_CALL}`);
  write("data.txt", "some data\n");
  write("lib/other.js", "exports.other = function other() {\n  return 'other';\n};\n");
  write("src/svc.js", SVC);
  write("src/throws.js", "exports.f = function f() {};\nthrow new Error('while loading');\n");
  write("src/main.js", MAIN);
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe("CommonJS layer", () => {
  test.each([
    ["-r", () => file("both.cjs")],
    ["--import", () => pathToFileURL(file("both.cjs")).href],
  ])("%s: in-scope exports are wrapped once; every other read sees the disk; nothing stays patched", (flag, pre) => {
    const r = node([flag, pre(), "src/main.js"]);
    expect(r.stderr).toBe("");
    const out = parse(r.stdout);
    expect(out.wrapped.slice(0, 2)).toEqual([
      { name: "getUser", file: "src/svc.js", line: 12 },
      { name: "label", file: "src/svc.js", line: 16 },
    ]);
    expect(out.marked).toBe(true);
    expect(out.user).toEqual({ id: 1 });
    // Reads while svc.js itself loaded (string, Buffer, an out-of-scope require) returned the disk bytes.
    expect(out.during).toEqual({ data: true, buffer: true, outside: true });
    expect(out.thrown).toBe("while loading");
    expect(out.afterThrow).toEqual({ read: true, data: "some data\n" });
    expect(out.cache).toEqual({ has: true, same: true });
    expect(out.again).toBe(true);
    // The loader stays wrapped (it heals); fs.readFileSync is back to what it was before Hoplens.
    expect(out.extIsOrig).toBe(false);
    expect(out.readIsSpy).toBe(true);
    // One layer (the `-r` preload also runs in the hooks worker, which registers nothing): each load once.
    expect(out.reports).toEqual([
      { type: "wrapped", file: "src/svc.js", fns: 2 },
      { type: "wrapped", file: "src/throws.js", fns: 1 },
      { type: "wrapped", file: "src/svc.js", fns: 2 },
    ]);
  });

  test("require.cache holds the same entries as without Hoplens", () => {
    const base = parse(node(["-r", file("before.cjs"), "src/main.js"]).stdout);
    const hooked = parse(node(["-r", file("both.cjs"), "src/main.js"]).stdout);
    expect(hooked.cacheKeys).toEqual(base.cacheKeys);
    expect(base.cacheKeys).toEqual(["lib/other.js", "src/main.js", "src/svc.js"]);
  });

  test("the in-scope read the handler makes gets the trailer; the spy under it saw the plain file", () => {
    write(
      "spy-main.js",
      `require("./src/svc");
const log = globalThis.__spyLog.filter((e) => e.p.endsWith("svc.js"));
console.log(JSON.stringify({ log, marked: Boolean(require("./src/svc").getUser.__hoplens) }));
`,
    );
    const out = parse(node(["-r", file("both.cjs"), "spy-main.js"]).stdout);
    expect(out.marked).toBe(true);
    // Node's own read (utf8) went through the swap to the spy: one read of the file, nothing else.
    expect(out.log).toEqual([{ p: file("src/svc.js"), str: true }]);
  });

  test("a loader that replaces the handler after Hoplens is wrapped on the next require (Buffer reads too)", () => {
    write(
      "late-loader.cjs",
      `const fs = require("node:fs");
const Module = require("node:module");
globalThis.__seen = [];
Module._extensions[".js"] = function lateLoader(mod, filename) {
  const b = fs.readFileSync(filename);
  const rel = require("node:path").relative(process.env.FX_ROOT, filename).split("\\\\").join("/");
  if (!rel.startsWith("..") && !require("node:path").isAbsolute(rel)) globalThis.__seen.push({ rel, buffer: Buffer.isBuffer(b), trailer: b.toString("utf8").includes("__tpw") });
  return mod._compile(b.toString("utf8"), filename);
};
`,
    );
    write(
      "late-main.js",
      `const svc = require("./src/svc");
console.log(JSON.stringify({ marked: Boolean(svc.getUser.__hoplens), seen: globalThis.__seen }));
`,
    );
    const r = node(["-r", file("preload.cjs"), "-r", file("late-loader.cjs"), "late-main.js"]);
    expect(r.stderr).toBe("");
    const out = parse(r.stdout);
    expect(out.marked).toBe(true);
    // late-main.js (outside src/) and lib/other.js read plain; svc.js read as a Buffer with the trailer.
    expect(out.seen).toEqual([
      { rel: "late-main.js", buffer: true, trailer: false },
      { rel: "src/svc.js", buffer: true, trailer: true },
      { rel: "lib/other.js", buffer: true, trailer: false },
    ]);
  });

  test("a SyntaxError reads the same as without Hoplens, and the swap is gone after it", () => {
    write("src/bad.js", "exports.f = function f() {\n  return 1;\n");
    write(
      "bad-main.js",
      `try { require("./src/bad"); } catch (e) { console.log(JSON.stringify({ name: e.name, message: e.message, read: require("node:fs").readFileSync === (globalThis.__spy || require("node:fs").readFileSync) })); }`,
    );
    const base = parse(node(["-r", file("before.cjs"), "bad-main.js"]).stdout);
    const hooked = parse(node(["-r", file("both.cjs"), "bad-main.js"]).stdout);
    expect(base).toEqual({ name: "SyntaxError", message: "Unexpected end of input", read: true });
    expect(hooked).toEqual(base);
  });

  test("the disposer puts Module._extensions and Module._load back; later requires load untouched", () => {
    write(
      "dispose-main.js",
      `const Module = require("node:module");
globalThis.__dispose();
const svc = require("./src/svc");
console.log(JSON.stringify({ js: Module._extensions[".js"] === globalThis.__orig.js, load: Module._load === globalThis.__orig.load, marked: Boolean(svc.getUser.__hoplens) }));
`,
    );
    const out = parse(node(["-r", file("both.cjs"), "dispose-main.js"]).stdout);
    expect(out).toEqual({ js: true, load: true, marked: false });
  });

  test("without register(), nothing is patched (the baseline the kill switches return to)", () => {
    const out = parse(node(["-r", file("before.cjs"), "src/main.js"]).stdout);
    expect(out.extIsOrig).toBe(true);
    expect(out.readIsSpy).toBe(true);
    expect(out.marked).toBe(false);
    expect(out.during).toEqual({ data: true, buffer: true, outside: true });
  });
});

describe("CommonJS layer next to other patchers", () => {
  /** append-transform's contract (nyc, istanbul): `.js` is an accessor that wraps every handler assigned to it. */
  const KEEP_LAST = `const Module = require("node:module");
const ext = Module._extensions;
let cur = ext[".js"];
const hooks = [];
const wrapHook = (h) => function keepLast(m, f) { return h(m, f); };
cur = wrapHook(cur);
hooks.push(cur);
Object.defineProperty(ext, ".js", { configurable: true, enumerable: true,
  get() { return cur; },
  set(h) { const i = hooks.indexOf(h); if (i === -1) { cur = wrapHook(h); hooks.push(cur); } else { hooks.splice(i + 1); cur = h; } } });
`;
  /** A loader that wraps fs.readFileSync the first time its handler runs (a cache or VFS layer). */
  const LAZY_READ = `const fs = require("node:fs");
const Module = require("node:module");
const old = Module._extensions[".js"];
let patched = false;
Module._extensions[".js"] = function (m, f) {
  if (!patched) { patched = true; const prev = fs.readFileSync; fs.readFileSync = function lazyRead() { globalThis.__lazyReads = (globalThis.__lazyReads || 0) + 1; return prev.apply(this, arguments); }; }
  return old.apply(this, arguments);
};
`;
  const N = 120;

  beforeAll(() => {
    write("keeplast.cjs", KEEP_LAST);
    write("lazyread.cjs", LAZY_READ);
    for (let i = 0; i < N; i++) {
      write(
        `src/many/m${i}.js`,
        `exports.f${i} = function f${i}() { return ${i}; };\n${i === N - 1 ? "Error.stackTraceLimit = Infinity; exports.frames = new Error().stack.split('\\n').length;\n" : ""}`,
      );
    }
    write(
      "many-main.js",
      `let last; for (let i = 0; i < ${N}; i++) last = require("./src/many/m" + i);
console.log(JSON.stringify({ frames: last.frames, wrapped: Boolean(last.f${N - 1}.__hoplens) }));
`,
    );
    write("src/lz/a.js", `exports.a = function a() { return "a"; };\nrequire("./b");\n`);
    write("src/lz/b.js", `exports.b = function b() { return "b"; };\n`);
    // The entry is in scope, so the loader's first run (and its fs.readFileSync patch) lands in a swap.
    write(
      "src/lz/main.js",
      `exports.main = function main() {};
const a = require("./a");
const b = require("./b");
const len = require("node:fs").readFileSync(__filename, "utf8").length > 0;
console.log(JSON.stringify({ a: a.a(), b: b.b(), len, marked: [Boolean(a.a.__hoplens), Boolean(b.b.__hoplens)], lazyReads: globalThis.__lazyReads > 0 }));
`,
    );
  });

  test.each([
    ["Hoplens first", () => ["-r", file("preload.cjs"), "-r", file("keeplast.cjs")]],
    ["Hoplens last", () => ["-r", file("keeplast.cjs"), "-r", file("preload.cjs")]],
  ])("an accessor that wraps every assigned handler (append-transform): the chain stays bounded (%s)", (_, pre) => {
    const base = parse(node(["-r", file("keeplast.cjs"), "many-main.js"]).stdout);
    const r = node([...pre(), "many-main.js"]);
    expect(r.stderr).toBe("");
    const out = parse(r.stdout);
    expect(out.wrapped).toBe(true);
    // A handful of frames for our wrapper and the extra keepLast, not two per require.
    expect(out.frames).toBeLessThan(base.frames + 10);
  });

  test("a loader that wraps fs.readFileSync during a swap does not loop the read", () => {
    const base = node(["-r", file("lazyread.cjs"), "src/lz/main.js"]);
    expect(base.stderr).toBe("");
    const r = node(["-r", file("preload.cjs"), "-r", file("lazyread.cjs"), "src/lz/main.js"]);
    expect(r.stderr).toBe("");
    const out = parse(r.stdout);
    expect(out).toEqual({ ...parse(base.stdout), marked: [true, true] });
  });
});
