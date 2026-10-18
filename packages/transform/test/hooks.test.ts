// The ESM load hook and register(), through real `node --import` child processes on the built dist/.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const DIST = path.resolve(__dirname, "..", "dist");
const REGISTER = path.join(DIST, "register.js");

let root: string;

/** A preload that registers the hook (twice, to prove idempotence) and prints every report. */
const PRELOAD = (extra = "") => `
const { register } = require(${JSON.stringify(REGISTER)});
const reports = [];
globalThis.__reports = reports;
const opts = { root: ${"process.env.FX_ROOT"}, include: ["src/**"], onReport: (r) => reports.push(r) };
const dispose = register(opts);
register(opts);
globalThis.__dispose = dispose;
${extra}
`;

/** Records what the trailer hands to globalThis.__hoplens.wrap. */
const SHIM = `
globalThis.__wrapped = [];
globalThis.__hoplens = { wrap(fn, meta) { globalThis.__wrapped.push(meta); const w = function (...a) { return fn.apply(this, a); }; w.__hoplens = true; return w; } };
`;

function node(args: string[], cwd = root): { stdout: string; stderr: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, FX_ROOT: cwd };
  for (const k of Object.keys(env)) if (k.startsWith("VITEST") || k === "NODE_OPTIONS") delete env[k];
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30000 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function write(rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  if (!fs.existsSync(path.join(DIST, "hooks.mjs"))) throw new Error("build @hoplens/transform first (pnpm build)");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-hooks-")));
  write("package.json", JSON.stringify({ type: "module" }));
  write("preload.cjs", PRELOAD(SHIM));
  write("src/a.js", "export function a() {\n  return 'a';\n}\nexport const b = () => 'b';\n");
  write("src/plain.js", "const x = 1;\nconsole.log(x ? '' : '');\n");
  write("src/old.cjs", "exports.c = function c() { return 'c'; };\n");
  write("outside.js", "export function out() { return 1; }\n");
  write(
    "src/main.js",
    `import { a, b } from "./a.js";
import "./plain.js";
import { c } from "./old.cjs";
import { out } from "../outside.js";
a(); b(); c(); out();
setTimeout(() => {
  console.log(JSON.stringify({ wrapped: globalThis.__wrapped, reports: globalThis.__reports, aMarked: Boolean(a.__hoplens) }));
}, 200);
`,
  );
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

const parse = (stdout: string) => JSON.parse(stdout.trim().split(/\r?\n/).pop()!);

describe("ESM hook", () => {
  test.each([
    ["--import", () => pathToFileURL(path.join(root, "preload.cjs")).href],
    ["-r", () => path.join(root, "preload.cjs")],
  ])("%s: in-scope modules are wrapped once, with their lines; the rest load untouched", (flag, preload) => {
    const r = node([flag, preload(), "src/main.js"]);
    expect(r.stderr).toBe("");
    const out = parse(r.stdout);
    expect(out.wrapped).toEqual([
      { name: "a", file: "src/a.js", line: 1 },
      { name: "b", file: "src/a.js", line: 4 },
    ]);
    expect(out.aMarked).toBe(true);
    // One hook instance: each file reported once, nothing else reported. The CommonJS file imported
    // from ESM reaches the CommonJS layer with its source already read by Node's ESM loader (reported
    // synchronously there, so in either order with the hook's report).
    expect(out.reports).toHaveLength(2);
    expect(out.reports).toContainEqual({ type: "wrapped", file: "src/a.js", fns: 2 });
    expect(out.reports).toContainEqual({ type: "refused", file: "src/old.cjs", reason: "esm-loader" });
  });

  test("a source that differs from the file on disk is refused and loads untouched", () => {
    // A loader that changes the source (what tsx does).
    write(
      "upstream.mjs",
      `export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.endsWith("/a.js")) return { ...r, source: String(r.source).replace("'a'", "'A'") };
  return r;
}
`,
    );
    write(
      "upstream.cjs",
      `require("node:module").register(require("node:url").pathToFileURL(${JSON.stringify(path.join(root, "upstream.mjs"))}).href);`,
    );
    // Registered first, so it runs on the source after ours asked for it (`--import tsx --import hoplens`).
    const r = node([
      "--import",
      pathToFileURL(path.join(root, "upstream.cjs")).href,
      "--import",
      pathToFileURL(path.join(root, "preload.cjs")).href,
      "src/main.js",
    ]);
    expect(r.stderr).toBe("");
    const out = parse(r.stdout);
    expect(out.wrapped).toEqual([]);
    expect(out.aMarked).toBe(false);
    expect(out.reports).toContainEqual({ type: "refused", file: "src/a.js", reason: "compiled" });
  });

  test("COMPILED mode: a .ts file another loader compiled first is mapped to its raw lines, or refused", () => {
    // Stands in for tsx: hands over esbuild-style output (one line, inline source map) for .ts files.
    const MAP = "//# sourceMappingURL=data:application/json;base64,e30=";
    write("src/ok.ts", "type N = number;\n\nexport function ok(a: N): N {\n  return a;\n}\n");
    write("src/odd.ts", "export function odd(a: number): number {\n  return a;\n}\n");
    write(
      "compiler.mjs",
      `const OUT = {
  "ok.ts": ${JSON.stringify(`function ok(a){return a}export{ok};\n\n${MAP}`)},
  "odd.ts": ${JSON.stringify(`var odd;odd=function(a){return a};export{odd};\n\n${MAP}`)},
};
export async function load(url, ctx, next) {
  const name = Object.keys(OUT).find((n) => new URL(url).pathname.endsWith("/" + n));
  if (url.startsWith("file:") && name) return { format: "module", source: OUT[name], shortCircuit: true };
  return next(url, ctx);
}
`,
    );
    write(
      "compiler.cjs",
      `require("node:module").register(require("node:url").pathToFileURL(${JSON.stringify(path.join(root, "compiler.mjs"))}).href);`,
    );
    write(
      "src/ts-main.js",
      `import { ok } from "./ok.ts";
import { ok as again } from "./ok.ts?v=2";
import { odd } from "./odd.ts";
import { d } from "data:text/javascript,export function d() { return 'd'; }";
setTimeout(() => console.log(JSON.stringify({
  values: [ok(1), again(2), odd(3), d()],
  marked: [Boolean(ok.__hoplens), Boolean(again.__hoplens), Boolean(odd.__hoplens), Boolean(d.__hoplens)],
  wrapped: globalThis.__wrapped,
  reports: globalThis.__reports,
})), 200);
`,
    );
    const r = node([
      "--import",
      pathToFileURL(path.join(root, "compiler.cjs")).href,
      "--import",
      pathToFileURL(path.join(root, "preload.cjs")).href,
      "src/ts-main.js",
    ]);
    expect(r.stderr).toBe("");
    const out = parse(r.stdout);
    expect(out.values).toEqual([1, 2, 3, "d"]);
    // A query string is the same file on disk; a data: URL has none and is left alone.
    expect(out.marked).toEqual([true, true, false, false]);
    expect(out.wrapped).toEqual([
      { name: "ok", file: "src/ok.ts", line: 3 },
      { name: "ok", file: "src/ok.ts", line: 3 },
    ]);
    expect(out.reports).toEqual([
      { type: "wrapped", file: "src/ok.ts", fns: 1 },
      { type: "wrapped", file: "src/ok.ts", fns: 1 },
      {
        type: "refused",
        file: "src/odd.ts",
        reason: "unmapped",
        detail: "odd: not one top-level function binding in the compiled source",
      },
    ]);
  });

  test("a file over the size limit is refused before it is parsed, and loads untouched", () => {
    const fns = Array.from({ length: 30000 }, (_, i) => `export function f${i}() { return ${i}; }`).join("\n");
    write("src/huge.js", `${fns}\n`);
    expect(fs.statSync(path.join(root, "src/huge.js")).size).toBeGreaterThan(1024 * 1024);
    write(
      "src/big-main.js",
      `import { f7 } from "./huge.js";
setTimeout(() => console.log(JSON.stringify({ v: f7(), marked: Boolean(f7.__hoplens), reports: globalThis.__reports })), 100);
`,
    );
    const r = node(["--import", pathToFileURL(path.join(root, "preload.cjs")).href, "src/big-main.js"]);
    expect(r.stderr).toBe("");
    const out = parse(r.stdout);
    expect(out.v).toBe(7);
    expect(out.marked).toBe(false);
    expect(out.reports).toEqual([{ type: "refused", file: "src/huge.js", reason: "large" }]);
  });

  test("a root reached through a symlink or junction still matches the real paths Node loads", () => {
    const link = `${root}-lnk`;
    try {
      fs.symlinkSync(root, link, "junction");
    } catch {
      return; // no symlink support here
    }
    try {
      const r = node(["--import", pathToFileURL(path.join(link, "preload.cjs")).href, "src/main.js"], link);
      expect(r.stderr).toBe("");
      const out = parse(r.stdout);
      expect(out.aMarked).toBe(true);
      expect(out.wrapped).toEqual([
        { name: "a", file: "src/a.js", line: 1 },
        { name: "b", file: "src/a.js", line: 4 },
      ]);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  test("the disposer turns the hook into a pass-through", () => {
    write("preload-off.cjs", PRELOAD(`${SHIM}\nglobalThis.__dispose();`));
    write("src/late.js", "export function late() { return 1; }\n");
    write(
      "src/dyn.js",
      `setTimeout(async () => {
  const m = await import("./late.js");
  console.log(JSON.stringify({ wrapped: globalThis.__wrapped, marked: Boolean(m.late.__hoplens) }));
}, 100);
`,
    );
    const r = node(["--import", pathToFileURL(path.join(root, "preload-off.cjs")).href, "src/dyn.js"]);
    expect(parse(r.stdout)).toEqual({ wrapped: [], marked: false });
  });

  test("register() off the main thread registers nothing", () => {
    write(
      "worker-main.cjs",
      `const { Worker } = require("node:worker_threads");
const w = new Worker(${JSON.stringify(`const { register } = require(${JSON.stringify(REGISTER)}); register({ root: process.cwd() }); require("node:worker_threads").parentPort.postMessage(Boolean(globalThis[Symbol.for("hoplens.transform.register")]));`)}, { eval: true });
w.on("message", (m) => console.log(JSON.stringify({ registeredInWorker: m })));
`,
    );
    expect(parse(node(["worker-main.cjs"]).stdout)).toEqual({ registeredInWorker: false });
  });
});

describe("ESM hook: CommonJS that Node reads itself", () => {
  test("--import with CommonJS TypeScript Node strips (.cts): the pristine source is wrapped in the hook", () => {
    const app = path.join(root, "ctsapp");
    const w = (rel: string, s: string) => write(path.join("ctsapp", rel), s);
    w("package.json", JSON.stringify({ name: "ctsapp", private: true }));
    w(
      "src/math.cts",
      "function add(a: number, b: number): number {\n  return a + b;\n}\nexports.add = add;\nexports.twice = (n: number): number => n * 2;\n",
    );
    w(
      "src/server.cts",
      `const math = require("./math.cts");
exports.handler = function handler(): number {
  return math.add(1, 2);
};
setTimeout(() => {
  console.log(JSON.stringify({ sum: exports.handler(), marked: [Boolean(math.add.__hoplens), Boolean(math.twice.__hoplens)], reports: globalThis.__reports }));
}, 200);
`,
    );
    const r = node(["--import", pathToFileURL(path.join(root, "preload.cjs")).href, "src/server.cts"], app);
    expect(r.stderr).not.toMatch(/Error:/);
    const out = parse(r.stdout);
    expect(out.sum).toBe(3);
    expect(out.marked).toEqual([true, true]);
    expect(out.reports).toEqual(
      expect.arrayContaining([
        { type: "wrapped", file: "src/server.cts", fns: 1 },
        { type: "wrapped", file: "src/math.cts", fns: 2 },
      ]),
    );
    expect(out.reports.filter((x: any) => x.type !== "wrapped")).toEqual([]);
  });
});
