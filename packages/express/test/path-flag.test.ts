// The request path's sticky switch: <stateDir>/path.json, read by the register hook at boot
// (HOPLENS_PATH=1/0 always wins), written by POST /__hoplens/api/path/enable|disable. Unit tests for
// the resolution matrix and the file helpers, then child processes for what a boot actually loads.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { pathBanner, pathOnLine } from "../src/banner";
import { shouldStart } from "../src/gate";
import {
  PATH_FLAG_FILE,
  earlyStateDir,
  pathControl,
  pathDecision,
  readPathFlag,
  removePathFlag,
  writePathFlag,
} from "../src/pathflag";
import { type Fixture, REGISTER, childEnv, freePort, makeFixture, poll, run } from "./helpers";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-pathflag-")));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const stateOf = (cwd: string) => path.join(cwd, "node_modules", ".cache", "hoplens");

type FlagCase = "present" | "absent" | "corrupt" | "disabled";
function setFlag(cwd: string, c: FlagCase): void {
  const dir = stateOf(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
  if (c === "absent") return;
  fs.mkdirSync(dir, { recursive: true });
  const body =
    c === "present"
      ? JSON.stringify({ enabled: true, since: "2026-10-19T00:00:00.000Z", by: "ui" })
      : c === "corrupt"
        ? "{ not json"
        : JSON.stringify({ enabled: false });
  fs.writeFileSync(path.join(dir, PATH_FLAG_FILE), body);
}

describe("resolution", () => {
  const cwd = tmp();
  const envs: Array<[string, string | undefined]> = [
    ["HOPLENS_PATH=1", "1"],
    ["HOPLENS_PATH=true", "true"],
    ["HOPLENS_PATH=0", "0"],
    ["HOPLENS_PATH unset", undefined],
  ];
  const flags: FlagCase[] = ["present", "absent", "corrupt", "disabled"];
  const modes: Array<string | undefined> = [undefined, "development", "production", "test"];
  const cases = envs.flatMap(([label, v]) => flags.flatMap((f) => modes.map((m) => [label, v, f, m] as const)));

  test.each(cases)("%s (%s), flag %s, NODE_ENV=%s", (_label, v, flag, mode) => {
    setFlag(cwd, flag);
    const env = { HOPLENS_PATH: v, NODE_ENV: mode };
    const d = pathDecision(env, cwd);
    // The env var always wins, both ways; else only a well-formed enabled flag turns it on.
    const want =
      v !== undefined
        ? { on: v === "1" || v === "true", source: "env" }
        : flag === "present"
          ? { on: true, source: "flag" }
          : { on: false, source: "default" };
    expect(d).toEqual({ ...want, stateDir: stateOf(cwd) });
    // The gate is unchanged: production / test keep everything off, the path included.
    const runs = shouldStart(env) && d.on;
    expect(runs).toBe(mode !== "production" && mode !== "test" && want.on);
  });

  test("the state dir honours HOPLENS_OPTIONS root and stateDir", () => {
    expect(earlyStateDir({}, cwd)).toBe(stateOf(cwd));
    const root = path.join(cwd, "app");
    expect(earlyStateDir({ HOPLENS_OPTIONS: JSON.stringify({ root }) }, cwd)).toBe(stateOf(root));
    expect(earlyStateDir({ HOPLENS_OPTIONS: JSON.stringify({ root, stateDir: ".hl" }) }, cwd)).toBe(
      path.join(root, ".hl"),
    );
    expect(earlyStateDir({ HOPLENS_OPTIONS: JSON.stringify({ stateDir: path.join(cwd, "abs") }) }, cwd)).toBe(
      path.join(cwd, "abs"),
    );
    expect(earlyStateDir({ HOPLENS_OPTIONS: "{bad" }, cwd)).toBe(stateOf(cwd));
    expect(earlyStateDir({ HOPLENS_OPTIONS: JSON.stringify({ enabled: false }) }, cwd)).toBeUndefined();
    expect(pathDecision({ HOPLENS_OPTIONS: JSON.stringify({ enabled: false }) }, cwd)).toEqual({
      on: false,
      source: "default",
      stateDir: undefined,
    });
  });
});

describe("flag file", () => {
  test("write is atomic JSON in the state dir (created), read back, remove is idempotent", () => {
    const dir = path.join(tmp(), "deep", "state");
    const flag = writePathFlag(dir, "init", new Date("2026-10-19T10:00:00Z"));
    expect(flag).toEqual({ enabled: true, since: "2026-10-19T10:00:00.000Z", by: "init" });
    expect(JSON.parse(fs.readFileSync(path.join(dir, PATH_FLAG_FILE), "utf8"))).toEqual(flag);
    // No temp file left behind.
    expect(fs.readdirSync(dir)).toEqual([PATH_FLAG_FILE]);
    expect(readPathFlag(dir)).toEqual(flag);
    writePathFlag(dir, "ui");
    expect(readPathFlag(dir)?.by).toBe("ui");
    removePathFlag(dir);
    expect(readPathFlag(dir)).toBeUndefined();
    expect(() => removePathFlag(dir)).not.toThrow();
    expect(readPathFlag(undefined)).toBeUndefined();
  });

  test("control: pending follows the file against the boot decision; env has none", () => {
    const dir = tmp();
    const off = pathControl({ on: false, source: "default", stateDir: dir });
    expect(off.pending()).toBeUndefined();
    off.enable();
    expect(off.pending()).toBe("on");
    off.disable();
    expect(off.pending()).toBeUndefined();

    writePathFlag(dir, "ui");
    const on = pathControl({ on: true, source: "flag", stateDir: dir });
    expect(on.pending()).toBeUndefined();
    on.disable();
    expect(on.pending()).toBe("off");

    const env = pathControl({ on: false, source: "env", stateDir: dir });
    writePathFlag(dir, "ui");
    expect(env.pending()).toBeUndefined();

    const none = pathControl({ on: false, source: "default", stateDir: undefined });
    expect(() => none.enable()).toThrow(/no state dir/);
  });

  test("banner names the source", () => {
    expect(pathOnLine("flag")).toBe("request path: on (flag; disable in the Path view, press x on a request)");
    expect(pathOnLine("env")).toBe("request path: on (HOPLENS_PATH)");
    expect(pathBanner({ state: "on" }, "flag")).toEqual({
      info: "request path: on (flag; disable in the Path view, press x on a request)",
    });
    expect(pathBanner({ state: "on" }, "env")).toEqual({ info: "request path: on (HOPLENS_PATH)" });
    expect(pathBanner({ state: "error", reason: "boom" }, "flag")?.note).toMatch(
      /press x on a request and disable it in the Path view to silence this/,
    );
  });
});

/* ------------------------------------------------------------ child processes */

const REGISTER_URL = pathToFileURL(REGISTER).href;

const SERVER = `const express = require("express");
const probe = () => ({
  inspector: process.moduleLoadList.includes("NativeModule inspector"),
  coverageModule: Object.keys(require.cache).some((k) => /[\\\\/]core[\\\\/]dist[\\\\/]coverage\\.js$/.test(k)),
  core: Object.keys(require.cache).some((k) => /[\\\\/]core[\\\\/]dist[\\\\/]|@hoplens[\\\\/]core/.test(k)),
  coverage: globalThis[Symbol.for("hoplens.coverage")] !== undefined,
});
const atStart = probe();
const app = express();
app.get("/hello", (_req, res) => res.json({ ok: true }));
app.get("/probe", (_req, res) => res.json(probe()));
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port, probe: atStart })));
`;

let fx: Fixture;
const children: Array<{ kill: () => Promise<void> }> = [];
beforeAll(() => {
  fx = makeFixture("express5", { "server.cjs": SERVER });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map((c) => c.kill()));
});
afterAll(() => fx?.cleanup());

function request(port: number, method: string, p: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let parsed: any = body;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function start(env: Record<string, string | undefined> = {}, flag: "-r" | "--import" = "-r") {
  const child = run(
    [flag, flag === "-r" ? REGISTER : REGISTER_URL, "server.cjs"],
    fx.root,
    childEnv({ HOPLENS_PORT: String(await freePort()), ...env }),
  );
  children.push(child);
  const ready = await child.waitFor<{ ready: number; probe: Record<string, boolean> }>("ready", 30000);
  return { port: ready.ready, probe: ready.probe, stdout: child.stdout };
}

const flagPath = () => path.join(stateOf(fx.root), PATH_FLAG_FILE);

describe("boot", () => {
  test("flag absent: the register hook loads no core, no inspector, no coverage module", async () => {
    setFlag(fx.root, "absent");
    const s = await start();
    expect(s.probe).toEqual({ inspector: false, coverageModule: false, core: false, coverage: false });
    const meta = await request(s.port, "GET", "/__hoplens/api/meta");
    expect(meta.body.path).toMatchObject({ state: "off", source: "default" });
    expect(meta.body.path.pending).toBeUndefined();
  }, 40000);

  test("flag corrupt: same as absent", async () => {
    setFlag(fx.root, "corrupt");
    const s = await start();
    expect(s.probe).toEqual({ inspector: false, coverageModule: false, core: false, coverage: false });
  }, 40000);

  test("flag present: coverage starts at boot; banner and meta say flag", async () => {
    setFlag(fx.root, "present");
    const s = await start({}, "--import");
    expect(s.probe).toMatchObject({ inspector: true, coverageModule: true, coverage: true });
    await poll(async () =>
      s.stdout().includes("request path: on (flag; disable in the Path view, press x on a request)") ? true : undefined,
    );
    const meta = await request(s.port, "GET", "/__hoplens/api/meta");
    expect(meta.body.path).toEqual({ state: "on", source: "flag" });
  }, 40000);

  test("HOPLENS_PATH=0 wins over the flag; the switch refuses", async () => {
    setFlag(fx.root, "present");
    const s = await start({ HOPLENS_PATH: "0" });
    expect(s.probe).toEqual({ inspector: false, coverageModule: false, core: false, coverage: false });
    const meta = await request(s.port, "GET", "/__hoplens/api/meta");
    expect(meta.body.path).toMatchObject({ state: "off", source: "env" });
    const r = await request(s.port, "POST", "/__hoplens/api/path/disable");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("env");
    expect(r.body.error).toMatch(/HOPLENS_PATH=0 .* always wins/);
    expect(fs.existsSync(flagPath())).toBe(true);
  }, 40000);
});

describe("switch API", () => {
  test("enable writes the flag (pending on), disable removes it; a foreign origin is refused", async () => {
    setFlag(fx.root, "absent");
    const s = await start();
    const on = await request(s.port, "POST", "/__hoplens/api/path/enable");
    expect(on.status).toBe(200);
    expect(on.body.path).toMatchObject({ state: "off", source: "default", pending: "on" });
    const flag = JSON.parse(fs.readFileSync(flagPath(), "utf8"));
    expect(flag).toMatchObject({ enabled: true, by: "ui" });
    expect(Number.isNaN(Date.parse(flag.since))).toBe(false);
    expect((await request(s.port, "GET", "/__hoplens/api/meta")).body.path.pending).toBe("on");

    const foreign = await request(s.port, "POST", "/__hoplens/api/path/disable", { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(fs.existsSync(flagPath())).toBe(true);
    // The UI's own origin (and a local dev server) is fine.
    const local = await request(s.port, "POST", "/__hoplens/api/path/disable", { origin: "http://localhost:5173" });
    expect(local.status).toBe(200);
    expect(local.body.path).toMatchObject({ state: "off", source: "default" });
    expect(local.body.path.pending).toBeUndefined();
    expect(fs.existsSync(flagPath())).toBe(false);
    // Still nothing of the path loaded in this process.
    expect((await request(s.port, "GET", "/probe")).body).toMatchObject({ inspector: false, coverage: false });
  }, 40000);

  test("on via flag: disable answers pending off", async () => {
    setFlag(fx.root, "present");
    const s = await start();
    const r = await request(s.port, "POST", "/__hoplens/api/path/disable");
    expect(r.status).toBe(200);
    expect(r.body.path).toEqual({ state: "on", source: "flag", pending: "off" });
    expect(fs.existsSync(flagPath())).toBe(false);
  }, 40000);
});
