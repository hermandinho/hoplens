// Function hops for CommonJS apps, end to end: an Express 5 app with no "type" in package.json, in child
// processes preloaded with the built register hook, compared with the same app run without function
// hops. Plain CommonJS JavaScript under -r and --import, tsc output in dist/ (opted in through
// autoTrace.include), TypeScript compiled to CommonJS by tsx in four flag orders, ts-node/register
// (transpile-only and type-checking, both -r orders), and the kill switches.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { type Fixture, PKG, REGISTER, childEnv, freePort, makeFixture, poll, run } from "./helpers";

// Each test starts two or more apps (one with function hops off, for the stack baseline).
vi.setConfig({ testTimeout: 60000 });

const REGISTER_URL = pathToFileURL(REGISTER).href;
const req = createRequire(path.join(PKG, "package.json"));

function resolveFrom(spec: string): string | undefined {
  try {
    return req.resolve(spec);
  } catch {
    return undefined;
  }
}

/** tsx's `--import` entry and its CLI, when the workspace has tsx. */
const TSX_PKG = resolveFrom("tsx/package.json");
const TSX_LOADER = TSX_PKG && pathToFileURL(path.join(path.dirname(TSX_PKG), "dist", "loader.mjs")).href;
const TSX_CLI = TSX_PKG && path.join(path.dirname(TSX_PKG), "dist", "cli.mjs");
/**
 * ts-node/register, a pinned devDependency of this package (10.9.2; its typescript and @types/node
 * peers are this package's). The rows only skip if it fails to resolve (an install that did not
 * link it), and then say so in the suite name.
 */
const TS_NODE = resolveFrom("ts-node/register");
const TS_NODE_SKIP = TS_NODE
  ? ""
  : " (skipped: ts-node/register did not resolve from packages/express; run pnpm install)";

/** Captures the originals before Hoplens loads, so the app can tell what is still patched. */
const CAPTURE = `const fs = require("node:fs");
const Module = require("node:module");
globalThis.__orig = { read: fs.readFileSync, js: Module._extensions[".js"], ts: Module._extensions[".ts"], load: Module._load };
`;

/** The services module: CommonJS export shapes (JS) or `export` syntax (TS), with the same lines. */
const SVC_JS = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
exports.dataOk = fs.readFileSync(path.join(__dirname, "..", "data.json"), "utf8") === '{"ok":true}';
async function getThing(id) {
  await new Promise((r) => setTimeout(r, 5));
  return { id, label: module.exports.label(id) };
}
exports.getThing = getThing;
exports.label = (id) => "#" + id;
exports.explode = function explode() {
  throw new Error("kaboom");
};
exports.mw = function mw(req, _res, next) {
  req.seen = true;
  next();
};
exports.onError = function onError(err, _req, res, _next) {
  res.status(500).json({ top: String(err.stack).split("\\n")[1].trim() });
};
`;

const SVC_TS = `import fs from "node:fs";
import path from "node:path";

export const dataOk = fs.readFileSync(path.join(__dirname, "..", "data.json"), "utf8") === '{"ok":true}';
export async function getThing(id: number) {
  await new Promise((r) => setTimeout(r, 5));
  return { id, label: label(id) };
}
export const label = (id: number): string => "#" + id;
export function explode(): never {
  throw new Error("kaboom");
}
export function mw(req: any, _res: any, next: () => void) {
  req.seen = true;
  next();
}
export function onError(err: any, _req: any, res: any, _next: unknown) {
  res.status(500).json({ top: String(err.stack).split("\\n")[1].trim() });
}
`;

/** Getter and frozen exports: load and run as without Hoplens, never wrapped. */
const ODD = `"use strict";
Object.defineProperty(exports, "viaGetter", { enumerable: true, get: () => viaGetter });
function viaGetter() {
  return "getter";
}
exports.frozen = function frozen() {
  return "frozen";
};
Object.freeze(exports);
`;

const SERVER = (svc: string, odd = "./odd") => `const express = require("express");
const fs = require("node:fs");
const Module = require("node:module");
const svc = require("${svc}");
const odd = require("${odd}");
const { getThing, explode, mw, onError } = svc;
const loaded = Object.keys(require.cache);
const o = globalThis.__orig || {};
const probe = {
  global: globalThis.__hoplens !== undefined,
  wrapped: Boolean(getThing.__hoplens),
  dataOk: svc.dataOk,
  read: fs.readFileSync === o.read,
  js: Module._extensions[".js"] === o.js,
  load: Module._load === o.load,
  typescript: loaded.some((k) => /[\\\\/]typescript[\\\\/]/.test(k)),
  transform: loaded.some((k) => /[\\\\/]transform[\\\\/]dist[\\\\/]|@hoplens[\\\\/]transform/.test(k)),
  core: loaded.some((k) => /[\\\\/]core[\\\\/]dist[\\\\/]|@hoplens[\\\\/]core/.test(k)),
  app: loaded.filter((k) => k.startsWith(process.cwd()) && !k.includes("node_modules")).length,
};
const app = express();
app.use(mw);
app.get("/thing/:id", async (req, res) => res.json(await getThing(Number(req.params.id))));
app.get("/boom", () => explode());
app.get("/odd", (_req, res) =>
  res.json({ getter: odd.viaGetter(), frozen: odd.frozen(), marked: Boolean(odd.viaGetter.__hoplens || odd.frozen.__hoplens) }),
);
app.use(onError);
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port, probe })));
`;

interface Res {
  status: number;
  body: string;
}

function get(port: number, p: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function traceFor(port: number, p: string): Promise<any> {
  const summary = await poll(async () => {
    const list = JSON.parse((await get(port, "/__hoplens/api/traces")).body) as any[];
    return list.find((t) => t.done && t.path === p);
  });
  return JSON.parse((await get(port, `/__hoplens/api/traces/${summary.id}`)).body);
}

interface Started {
  port: number;
  probe: Record<string, unknown>;
  stdout: () => string;
  stderr: () => string;
  kill: () => Promise<void>;
}

const started: Started[] = [];

/** Starts the app; the whole process tree is stopped at the end (the tsx CLI runs it in a child). */
async function start(args: string[], env: Record<string, string | undefined> = {}): Promise<Started> {
  const child = run(["-r", fx.capture, ...args], fx.root, childEnv({ HOPLENS_PORT: String(await freePort()), ...env }));
  const ready = await child.waitFor<{ ready: number; probe: Record<string, unknown> }>("ready", 30000);
  const pid = child.proc.pid;
  const s: Started = {
    port: ready.ready,
    probe: ready.probe,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: async () => {
      if (process.platform === "win32" && pid)
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      await child.kill();
    },
  };
  started.push(s);
  return s;
}

async function topFrame(s: Started): Promise<string> {
  const res = await get(s.port, "/boom");
  expect(res.status).toBe(500);
  return JSON.parse(res.body).top;
}

const fnSpans = (t: any) => t.spans.filter((x: any) => x.kind === "function");
const banner = (s: Started) => poll(async () => (s.stdout().includes("◆ Hoplens") ? s.stdout() : undefined));

/** handler > getThing > label at `file`'s lines, no middleware hop, and the odd exports untouched. */
async function expectHops(s: Started, file: string, lines: { getThing: number; label: number }, id: number) {
  expect(s.probe).toMatchObject({ global: true, wrapped: true, dataOk: true, read: true });
  expect(JSON.parse((await get(s.port, `/thing/${id}`)).body)).toEqual({ id, label: `#${id}` });
  const t = await traceFor(s.port, `/thing/${id}`);
  const handler = t.spans.find((x: any) => x.kind === "handler");
  const getThing = fnSpans(t).find((x: any) => x.name === "getThing");
  const label = fnSpans(t).find((x: any) => x.name === "label");
  expect(getThing?.parentId).toBe(handler?.id);
  expect(getThing.location).toMatchObject({ file, line: lines.getThing });
  expect(label?.parentId).toBe(getThing.id);
  expect(label.location).toMatchObject({ file, line: lines.label });
  expect(fnSpans(t).map((x: any) => x.name)).not.toContain("mw");
  expect(JSON.parse((await get(s.port, "/odd")).body)).toEqual({ getter: "getter", frozen: "frozen", marked: false });
}

let fx: Fixture & { capture: string };
beforeAll(() => {
  // Real tsc CommonJS output for dist/: `exports.X = void 0` header, `exports.X = X`, and a re-export
  // through an Object.defineProperty getter.
  const ts = require("@hoplens/transform").loadTypeScript(PKG);
  const tsc = (src: string) =>
    ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
  const labels = 'export const label = (id: number): string => "#" + id;\n';
  const distSvc = tsc(
    SVC_TS.replace('export const label = (id: number): string => "#" + id;\n', "").replace(
      "export function explode",
      'import { label } from "./labels";\nexport { label };\nexport function explode',
    ),
  );
  const f = makeFixture("express5", {
    "capture.cjs": CAPTURE,
    "data.json": '{"ok":true}',
    "src/svc.js": SVC_JS,
    "src/odd.js": ODD,
    "src/server.js": SERVER("./svc"),
    "src/tsvc.ts": SVC_TS,
    "src/server-ts.ts": SERVER("./tsvc"),
    // Strictly typed, for ts-node's type-checking mode: export syntax and CommonJS syntax.
    "src/tc-esm.ts":
      "export function getThing(id: number): { id: number } {\n  return { id };\n}\nexport const label = (n: number): string => `#${n}`;\n",
    "src/tc-cjs.ts":
      "function add(a: number, b: number): number {\n  return a + b;\n}\nexports.add = add;\nmodule.exports.twice = (n: number): number => n * 2;\n",
    "src/tc-main.ts":
      'import { getThing, label } from "./tc-esm";\nconst cjs = require("./tc-cjs");\nconst hops = [getThing, label, cjs.add, cjs.twice].map((f: any) => Boolean(f.__hoplens));\nconsole.log(JSON.stringify({ tc: { hops, out: [getThing(1).id, label(2), cjs.add(1, 2), cjs.twice(2)] } }));\nprocess.exit(0);\n',
    "dist/svc.js": distSvc,
    "dist/labels.js": tsc(labels),
    "dist/odd.js": ODD,
    "dist/server.js": SERVER("./svc"),
  });
  fx = { ...f, capture: path.join(f.root, "capture.cjs") };
});

// Two dozen apps, each stopped with a taskkill /T on Windows: well over the default 10 s hook timeout.
afterAll(async () => {
  for (const s of started.splice(0)) await s.kill();
  fx?.cleanup();
}, 120000);

describe("plain CommonJS JavaScript", () => {
  test.each([
    ["-r", ["-r", REGISTER]],
    ["--import", ["--import", REGISTER_URL]],
  ])("%s: handler > fn > fn at the file's lines; same stack as HOPLENS_AUTOTRACE=0", async (_l, flags) => {
    const s = await start([...flags, "src/server.js"]);
    await expectHops(s, "src/svc.js", { getThing: 5, label: 10 }, 7);
    // The loader stays wrapped (it re-heals); fs.readFileSync is the original again.
    expect(s.probe).toMatchObject({ js: false, read: true });
    const out = await banner(s);
    expect(out).toContain("function hops: 6 fns in 2 files");
    expect(out).not.toContain("function hops skipped");
    expect(s.stderr()).toBe("");
    const off = await start([...flags, "src/server.js"], { HOPLENS_AUTOTRACE: "0" });
    expect(off.probe.wrapped).toBe(false);
    expect(off.probe.app).toBe(s.probe.app);
    const want = await topFrame(off);
    expect(want).toMatch(/svc\.js:12:9\)?$/);
    expect(await topFrame(s)).toBe(want);
  });

  test("middleware and the 4-arg error handler get no function hop", async () => {
    const s = await start(["-r", REGISTER, "src/server.js"]);
    await get(s.port, "/boom");
    const names = fnSpans(await traceFor(s.port, "/boom")).map((x: any) => x.name);
    expect(names).toContain("explode");
    expect(names).not.toContain("mw");
    expect(names).not.toContain("onError");
  });
});

describe("tsc output in dist/", () => {
  test("excluded by default; with autoTrace.include dist/** it is wrapped, the getter re-export untouched", async () => {
    const def = await start(["-r", REGISTER, "dist/server.js"]);
    expect(def.probe.wrapped).toBe(false);
    expect(await banner(def)).not.toContain("function hops:");

    const s = await start(["-r", REGISTER, "dist/server.js"], {
      HOPLENS_OPTIONS: JSON.stringify({ autoTrace: { include: ["dist/**"] } }),
    });
    expect(s.probe.wrapped).toBe(true);
    expect(JSON.parse((await get(s.port, "/thing/4")).body)).toEqual({ id: 4, label: "#4" });
    const t = await traceFor(s.port, "/thing/4");
    const getThing = fnSpans(t).find((x: any) => x.name === "getThing");
    expect(getThing?.location?.file).toBe("dist/svc.js");
    // `label` comes through tsc's re-export getter: it is wrapped in dist/labels.js, where it is defined.
    expect(fnSpans(t).find((x: any) => x.name === "label")?.location?.file).toBe("dist/labels.js");
    expect(JSON.parse((await get(s.port, "/odd")).body)).toEqual({ getter: "getter", frozen: "frozen", marked: false });
    const off = await start(["-r", REGISTER, "dist/server.js"], { HOPLENS_AUTOTRACE: "0" });
    expect(await topFrame(s)).toBe(await topFrame(off));
  });
});

describe.skipIf(!TSX_LOADER || !TSX_CLI || !fs.existsSync(TSX_CLI ?? ""))(
  "TypeScript compiled to CommonJS by tsx",
  () => {
    test.each([
      ["--import hoplens --import tsx", () => ["--import", REGISTER_URL, "--import", TSX_LOADER!]],
      ["--import tsx --import hoplens", () => ["--import", TSX_LOADER!, "--import", REGISTER_URL]],
      ["-r hoplens --import tsx", () => ["-r", REGISTER, "--import", TSX_LOADER!]],
      // The CLI runs the app in a child node: the capture preload goes to it as well.
      ["tsx CLI --import hoplens", () => [TSX_CLI!, "-r", fx.capture, "--import", REGISTER_URL]],
    ])("%s: function hops at the raw .ts lines; same stack as HOPLENS_AUTOTRACE=0", async (_l, flags) => {
      const s = await start([...flags(), "src/server-ts.ts"]);
      await expectHops(s, "src/tsvc.ts", { getThing: 5, label: 9 }, 8);
      const out = await banner(s);
      expect(out).toContain("function hops: 6 fns in 2 files");
      expect(out).not.toContain("function hops skipped");
      const off = await start([...flags(), "src/server-ts.ts"], { HOPLENS_AUTOTRACE: "0" });
      expect(off.probe.wrapped).toBe(false);
      const want = await topFrame(off);
      expect(want).toMatch(/tsvc\.ts:11:9\)?$/);
      expect(await topFrame(s)).toBe(want);
    });
  },
);

describe.skipIf(!TS_NODE)(`ts-node/register${TS_NODE_SKIP}`, () => {
  test("function hops at the raw .ts lines; same stack as HOPLENS_AUTOTRACE=0", async () => {
    const flags = ["-r", TS_NODE!, "-r", REGISTER];
    // module commonjs: ts-node's bundled @tsconfig/node* default (NodeNext) needs a tsconfig to resolve.
    const env = { TS_NODE_TRANSPILE_ONLY: "1", TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs" }) };
    const s = await start([...flags, "src/server-ts.ts"], env);
    await expectHops(s, "src/tsvc.ts", { getThing: 5, label: 9 }, 9);
    const off = await start([...flags, "src/server-ts.ts"], { ...env, HOPLENS_AUTOTRACE: "0" });
    expect(await topFrame(s)).toBe(await topFrame(off));
  });
});

describe.skipIf(!TS_NODE)(`ts-node/register, type-checking (its default mode)${TS_NODE_SKIP}`, () => {
  /** strict, with @types/node from this package: what the fixture needs to type-check on its own. */
  const env = () => ({
    TS_NODE_COMPILER_OPTIONS: JSON.stringify({
      strict: true,
      module: "commonjs",
      target: "es2022",
      esModuleInterop: true,
      types: ["node"],
      typeRoots: [path.join(PKG, "node_modules", "@types")],
    }),
  });
  test.each([
    ["ts-node first", () => ["-r", TS_NODE!, "-r", REGISTER]],
    ["Hoplens first", () => ["-r", REGISTER, "-r", TS_NODE!]],
  ])(
    "%s: the app boots and every export is wrapped (the trailer type-checks)",
    async (_l, flags) => {
      // A type-checking boot loads all of @types/node: 10-20 s each on a loaded machine, so the two
      // children run side by side, with room to spare.
      type Tc = { tc: { hops: boolean[]; out: unknown[] } };
      const off = run([...flags(), "src/tc-main.ts"], fx.root, childEnv({ ...env(), HOPLENS_AUTOTRACE: "0" }));
      const on = run([...flags(), "src/tc-main.ts"], fx.root, childEnv(env()));
      const [base, got] = await Promise.all([off.waitFor<Tc>("tc", 90000), on.waitFor<Tc>("tc", 90000)]);
      expect(base.tc).toEqual({ hops: [false, false, false, false], out: [1, "#2", 3, 4] });
      expect(on.stderr()).not.toContain("TSError");
      expect(got.tc).toEqual({ hops: [true, true, true, true], out: [1, "#2", 3, 4] });
    },
    120000,
  );
});

describe("kill switches and the gate", () => {
  test.each([
    ["HOPLENS_AUTOTRACE=0", { HOPLENS_AUTOTRACE: "0" }],
    ["HOPLENS_OPTIONS autoTrace:false", { HOPLENS_OPTIONS: JSON.stringify({ autoTrace: false }) }],
    ["gate off (HOPLENS=0)", { HOPLENS: "0" }],
  ])("%s: Module._extensions, Module._load and fs.readFileSync are the originals; nothing wrapped", async (_l, env) => {
    const s = await start(["-r", REGISTER, "src/server.js"], env);
    expect(s.probe).toMatchObject({
      wrapped: false,
      read: true,
      js: true,
      load: true,
      typescript: false,
      transform: false,
    });
    expect(JSON.parse((await get(s.port, "/thing/1")).body)).toEqual({ id: 1, label: "#1" });
  });
});
