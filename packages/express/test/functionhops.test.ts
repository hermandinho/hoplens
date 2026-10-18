// Function hops end to end: a type:module Express 5 app in child processes, preloaded with the built
// register hook (which registers @hoplens/transform's ESM hook), compared with the same app run
// without Hoplens. Covers plain ESM JS, TypeScript Node strips itself, both tsx flag orders and the
// tsx CLI (COMPILED mode), `-r`, the kill switches and the gate.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Fixture, PKG, REGISTER, childEnv, freePort, makeFixture, poll, run } from "./helpers";

const REGISTER_URL = pathToFileURL(REGISTER).href;

/** tsx's `--import` entry, when the workspace has tsx. */
function tsxLoader(): string | undefined {
  try {
    const pkg = createRequire(path.join(PKG, "package.json")).resolve("tsx/package.json");
    const loader = path.join(path.dirname(pkg), "dist", "loader.mjs");
    return fs.existsSync(loader) ? pathToFileURL(loader).href : undefined;
  } catch {
    return undefined;
  }
}
const TSX = tsxLoader();
const STRIPS_TYPES = Boolean((process.features as { typescript?: unknown }).typescript);

/** The services module, in JS and in TypeScript (same lines, so the same line numbers). */
const SVC_BODY = (ts: boolean) => `export async function getThing(id${ts ? ": number" : ""}) {
  await new Promise((r) => setTimeout(r, 5));
  return { id, label: label(id) };
}
export const label = (id${ts ? ": number" : ""}) => "#" + id;
export function explode()${ts ? ": never" : ""} {
  throw new Error("kaboom");
}
export function mw(req${ts ? ": any" : ""}, _res${ts ? ": any" : ""}, next${ts ? ": () => void" : ""}) {
  req.seen = true;
  next();
}
export function onError(err${ts ? ": any" : ""}, _req${ts ? ": any" : ""}, res${ts ? ": any" : ""}, _next${ts ? ": unknown" : ""}) {
  res.status(500).json({ top: String(err.stack).split("\\n")[1].trim() });
}
`;

const SERVER = (svc: string, extra = "") => `import express from "express";
import { createRequire } from "node:module";
import { explode, getThing, mw, onError } from "${svc}";
${extra}
const loaded = Object.keys(createRequire(import.meta.url).cache);
const probe = {
  global: globalThis.__hoplens !== undefined,
  shim: Boolean(globalThis.__hoplens && globalThis.__hoplens.shim),
  wrapped: Boolean(getThing.__hoplens),
  typescript: loaded.some((k) => /[\\\\/]typescript[\\\\/]/.test(k)),
  transform: loaded.some((k) => /[\\\\/]transform[\\\\/]dist[\\\\/]|@hoplens[\\\\/]transform/.test(k)),
  core: loaded.some((k) => /[\\\\/]core[\\\\/]dist[\\\\/]|@hoplens[\\\\/]core/.test(k)),
};
const app = express();
app.use(mw);
app.get("/thing/:id", async (req, res) => res.json(await getThing(Number(req.params.id))));
app.get("/boom", () => explode());
if (globalThis.__odd) app.get("/odd", async (_req, res) => res.json(await globalThis.__odd()));
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
  pid?: number;
  port: number;
  probe: Record<string, boolean>;
  stdout: () => string;
  stderr: () => string;
  kill: () => Promise<void>;
}

const started: Started[] = [];

async function start(fx: Fixture, args: string[], env: Record<string, string | undefined> = {}): Promise<Started> {
  const child = run(args, fx.root, childEnv({ HOPLENS_PORT: String(await freePort()), ...env }));
  const ready = await child.waitFor<{ ready: number; probe: Record<string, boolean> }>("ready", 30000);
  const s = {
    pid: child.proc.pid,
    port: ready.ready,
    probe: ready.probe,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: child.kill,
  };
  started.push(s);
  return s;
}

/** The top stack frame of the thrown error, as the app's own error middleware reports it. */
async function topFrame(s: Started): Promise<string> {
  const res = await get(s.port, "/boom");
  expect(res.status).toBe(500);
  return JSON.parse(res.body).top;
}

const fnSpans = (t: any) => t.spans.filter((x: any) => x.kind === "function");

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture("express5", {
    "package.json": JSON.stringify({ name: "fixture-app", private: true, type: "module" }),
    "src/svc.js": SVC_BODY(false),
    "src/tsvc.ts": SVC_BODY(true),
    "src/legacy.cjs": "exports.old = function old() {\n  return 'old';\n};\n",
    "src/server.js": SERVER("./svc.js", 'import { old } from "./legacy.cjs";\nold();'),
    "src/server-ts.js": SERVER("./tsvc.ts"),
    "src/server.ts": SERVER("./tsvc.ts"),
    // esbuild lowers a top-level `using` by moving the bindings into a try block: COMPILED mode refuses.
    "src/usvc.ts": `export function tidy(n: number): number {
  return n + 1;
}

export const later = async (): Promise<number> => 2;

using res = { [Symbol.dispose]() {} };
`,
    "src/server-odd.ts": SERVER(
      "./tsvc.ts",
      `import { later, tidy } from "./usvc.ts";
(globalThis as any).__odd = async () => ({ tidy: tidy(1), later: await later(), marked: Boolean((tidy as any).__hoplens || (later as any).__hoplens) });`,
    ),
    // Unclosed block: must fail exactly as without Hoplens.
    "src/bad.js": "export function f() {\n  return 1;\n",
  });
});

afterAll(async () => {
  for (const s of started.splice(0)) await s.kill();
  fx?.cleanup();
});

describe("ESM JavaScript (--import)", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(fx, ["--import", REGISTER_URL, "src/server.js"]);
  });

  test("the shim is in before user code; the main thread loads no TypeScript", () => {
    expect(s.probe).toMatchObject({ global: true, wrapped: true, typescript: false });
  });

  test("handler > fn > fn, with the file and line of each function", async () => {
    expect(JSON.parse((await get(s.port, "/thing/7")).body)).toEqual({ id: 7, label: "#7" });
    const t = await traceFor(s.port, "/thing/7");
    const handler = t.spans.find((x: any) => x.kind === "handler");
    const getThing = t.spans.find((x: any) => x.kind === "function" && x.name === "getThing");
    const label = t.spans.find((x: any) => x.kind === "function" && x.name === "label");
    expect(handler?.name).toBe("GET /thing/:id");
    expect(getThing?.parentId).toBe(handler.id);
    expect(getThing.location).toMatchObject({ file: "src/svc.js", line: 1 });
    // An intra-module call goes through the ESM live binding, so it is wrapped too.
    expect(label?.parentId).toBe(getThing.id);
    expect(label.location).toMatchObject({ file: "src/svc.js", line: 5 });
  });

  test("middleware and the 4-arg error handler get no function hop", async () => {
    await get(s.port, "/boom");
    const t = await traceFor(s.port, "/boom");
    const names = fnSpans(t).map((x: any) => x.name);
    expect(names).toContain("explode");
    expect(names).not.toContain("mw");
    expect(names).not.toContain("onError");
    const thing = await traceFor(s.port, "/thing/7");
    expect(fnSpans(thing).map((x: any) => x.name)).not.toContain("mw");
  });

  test("the thrown error's top frame is the same as without Hoplens", async () => {
    const base = await start(fx, ["src/server.js"]);
    expect(base.probe.global).toBe(false);
    const want = await topFrame(base);
    expect(want).toMatch(/svc\.js:7:9\)?$/);
    expect(await topFrame(s)).toBe(want);
  });

  test("the banner counts the wrapped functions and the CommonJS file it left alone, on one line", async () => {
    const out = await poll(async () => (s.stdout().includes("function hops:") ? s.stdout() : undefined));
    expect(out).toContain("function hops: 5 fns in 1 file");
    expect(out.split("function hops skipped").length - 1).toBe(1);
    // legacy.cjs is imported from ESM: Node's ESM loader read it, so the CommonJS layer could not swap it.
    expect(out).toContain(
      "function hops skipped for 1 CommonJS file Node loaded through its ESM loader (src/legacy.cjs), as it does for the entry under --import and for a CommonJS file imported from ESM",
    );
  });
});

describe("-r preload", () => {
  test("the hook registers once (main thread only): each function wraps once", async () => {
    const s = await start(fx, ["-r", REGISTER, "src/server.js"]);
    expect(s.probe.wrapped).toBe(true);
    await get(s.port, "/thing/8");
    const t = await traceFor(s.port, "/thing/8");
    expect(fnSpans(t).map((x: any) => x.name)).toEqual(["getThing", "label"]);
    const out = await poll(async () => (s.stdout().includes("function hops:") ? s.stdout() : undefined));
    expect(out).toContain("function hops: 5 fns in 1 file");
    expect(out).not.toContain("compiled by another loader");
  });
});

describe("kill switches and the gate", () => {
  test.each([
    ["HOPLENS_AUTOTRACE=0", { HOPLENS_AUTOTRACE: "0" }],
    ["HOPLENS_OPTIONS autoTrace:false", { HOPLENS_OPTIONS: JSON.stringify({ autoTrace: false }) }],
  ])("%s: no shim, no transform, no TypeScript, nothing wrapped", async (_label, env) => {
    const s = await start(fx, ["--import", REGISTER_URL, "src/server.js"], env);
    expect(s.probe).toEqual({
      global: false,
      shim: false,
      wrapped: false,
      typescript: false,
      transform: false,
      core: false,
    });
    await get(s.port, "/thing/9");
    const t = await traceFor(s.port, "/thing/9");
    expect(t.spans.some((x: any) => x.kind === "handler")).toBe(true);
    expect(fnSpans(t)).toEqual([]);
    expect(s.stdout()).not.toContain("function hops");
  });

  test("gate off (HOPLENS=0): nothing loads, the app runs as without Hoplens", async () => {
    const s = await start(fx, ["--import", REGISTER_URL, "src/server.js"], { HOPLENS: "0" });
    expect(s.probe).toEqual({
      global: false,
      shim: false,
      wrapped: false,
      typescript: false,
      transform: false,
      core: false,
    });
    expect(JSON.parse((await get(s.port, "/thing/1")).body)).toEqual({ id: 1, label: "#1" });
  });
});

describe("a file that does not parse", () => {
  /** Node's report of the uncaught SyntaxError, through its message line (the frames below are Node's). */
  async function report(args: string[]): Promise<string> {
    const child = run(args, fx.root, childEnv());
    await child.exited;
    const lines = child.stderr().split(/\r?\n/);
    return lines.slice(0, lines.findIndex((l) => l.startsWith("SyntaxError")) + 1).join("\n");
  }

  test("fails with the same error, at the same line, as without Hoplens", async () => {
    const want = await report(["src/bad.js"]);
    expect(want).toMatch(/bad\.js:3[\s\S]*SyntaxError: Unexpected end of input$/);
    expect(await report(["--import", REGISTER_URL, "src/bad.js"])).toBe(want);
  });
});

describe.skipIf(!STRIPS_TYPES)("TypeScript stripped by Node", () => {
  test("wrapped, with the .ts line, and the same top frame", async () => {
    const s = await start(fx, ["--import", REGISTER_URL, "src/server-ts.js"]);
    expect(s.probe.wrapped).toBe(true);
    await get(s.port, "/thing/2");
    const t = await traceFor(s.port, "/thing/2");
    const fn = fnSpans(t).find((x: any) => x.name === "getThing");
    expect(fn?.location).toMatchObject({ file: "src/tsvc.ts", line: 1 });
    const base = await start(fx, ["src/server-ts.js"]);
    expect(await topFrame(s)).toBe(await topFrame(base));
  });
});

describe.skipIf(!TSX)("tsx", () => {
  test("--import hoplens --import tsx: Hoplens sees the raw TypeScript and wraps it", async () => {
    const s = await start(fx, ["--import", REGISTER_URL, "--import", TSX!, "src/server-ts.js"]);
    expect(s.probe.wrapped).toBe(true);
    await get(s.port, "/thing/3");
    const t = await traceFor(s.port, "/thing/3");
    const fn = fnSpans(t).find((x: any) => x.name === "getThing");
    expect(fn?.location).toMatchObject({ file: "src/tsvc.ts", line: 1 });
    expect(fnSpans(t).map((x: any) => x.name)).not.toContain("mw");
    const base = await start(fx, ["--import", TSX!, "src/server-ts.js"]);
    expect(await topFrame(s)).toBe(await topFrame(base));
  });

  test("--import tsx --import hoplens: COMPILED mode wraps tsx's output, raw lines, same stack", async () => {
    const s = await start(fx, ["--import", TSX!, "--import", REGISTER_URL, "src/server-ts.js"]);
    await expectTsHops(s, 4);
    const out = await poll(async () => (s.stdout().includes("function hops:") ? s.stdout() : undefined));
    expect(out).toContain("function hops: 5 fns in 1 file");
    expect(out).not.toContain("function hops skipped");
    expect(s.stderr()).toBe("");
    const off = await start(fx, ["--import", TSX!, "--import", REGISTER_URL, "src/server-ts.js"], {
      HOPLENS_AUTOTRACE: "0",
    });
    expect(off.probe.wrapped).toBe(false);
    const want = await topFrame(off);
    expect(want).toMatch(/tsvc\.ts:7:9\)?$/);
    expect(await topFrame(s)).toBe(want);
  });
});

/** handler > getThing > label, at the raw TypeScript lines, and no middleware hop. */
async function expectTsHops(s: Started, id: number) {
  expect(s.probe.wrapped).toBe(true);
  expect(JSON.parse((await get(s.port, `/thing/${id}`)).body)).toEqual({ id, label: `#${id}` });
  const t = await traceFor(s.port, `/thing/${id}`);
  const handler = t.spans.find((x: any) => x.kind === "handler");
  const getThing = fnSpans(t).find((x: any) => x.name === "getThing");
  const label = fnSpans(t).find((x: any) => x.name === "label");
  expect(getThing?.parentId).toBe(handler?.id);
  expect(getThing.location).toMatchObject({ file: "src/tsvc.ts", line: 1 });
  expect(label?.parentId).toBe(getThing.id);
  expect(label.location).toMatchObject({ file: "src/tsvc.ts", line: 5 });
  expect(fnSpans(t).map((x: any) => x.name)).not.toContain("mw");
}

/** The tsx CLI (what `hoplens init` writes: `tsx [watch] --import hoplens/express/register <entry>`). */
const TSX_CLI = (() => {
  if (!TSX) return undefined;
  const cli = path.join(path.dirname(fileURLToPath(TSX)), "cli.mjs");
  return fs.existsSync(cli) ? cli : undefined;
})();

/** The tsx CLI runs the app in a child process of its own: stop the whole tree, not just the CLI. */
async function startTree(args: string[], env: Record<string, string | undefined> = {}): Promise<Started> {
  const s = await start(fx, args, env);
  const kill = s.kill;
  s.kill = async () => {
    if (process.platform === "win32" && s.pid)
      spawnSync("taskkill", ["/pid", String(s.pid), "/T", "/F"], { stdio: "ignore" });
    await kill();
  };
  return s;
}

// Each case starts the tsx CLI (which spawns the app as a child) twice: ~4.6s alone, more under load.
describe.skipIf(!TSX_CLI)("tsx CLI (COMPILED mode)", { timeout: 30_000 }, () => {
  test.each([
    ["tsx --import hoplens", [] as string[]],
    ["tsx watch --import hoplens", ["watch"]],
  ])("%s: handler > function hop at the raw file:line, same stack as HOPLENS_AUTOTRACE=0", async (_l, sub) => {
    const args = [TSX_CLI!, ...sub, "--import", REGISTER_URL, "src/server.ts"];
    const s = await startTree(args);
    await expectTsHops(s, 5);
    const out = await poll(async () => (s.stdout().includes("function hops:") ? s.stdout() : undefined));
    expect(out).toContain("function hops: 5 fns in 1 file");
    expect(out).not.toContain("function hops skipped");
    const off = await startTree(args, { HOPLENS_AUTOTRACE: "0" });
    expect(off.probe.wrapped).toBe(false);
    const want = await topFrame(off);
    expect(want).toMatch(/tsvc\.ts:7:9\)?$/);
    expect(await topFrame(s)).toBe(want);
  });

  test("a file COMPILED mode cannot map is refused in one line; it and the app run as without Hoplens", async () => {
    const s = await startTree([TSX_CLI!, "--import", REGISTER_URL, "src/server-odd.ts"]);
    await expectTsHops(s, 6);
    expect(JSON.parse((await get(s.port, "/odd")).body)).toEqual({ tidy: 2, later: 2, marked: false });
    const out = await poll(async () => (s.stdout().includes("function hops:") ? s.stdout() : undefined));
    expect(out).toContain("function hops: 5 fns in 1 file");
    const refusals = out.split("\n").filter((l) => l.includes("function hops skipped"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain(
      "function hops skipped for 1 TypeScript file whose compiled output (tsx?) Hoplens could not map back to the source (src/usvc.ts: later:",
    );
    expect(s.stderr()).toBe("");
  });
});
