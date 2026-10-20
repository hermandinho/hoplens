// The request path's sticky flag from the CLI: init asks (TTY only) or takes --path / --no-path and
// writes node_modules/.cache/hoplens/path.json (the file the Express register hook reads at boot);
// --dry-run prints it; remove deletes it; doctor reports who turns the path on.
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { doctor } from "../src/commands/doctor";
import { init } from "../src/commands/init";
import { remove } from "../src/commands/remove";
import { PATH_QUESTION, doctorPath } from "../src/express/commands";
import { insideDir, scriptEnv } from "../src/express/pathflag";
import type { PromptIO } from "../src/prompt";
import { captureConsole, installFake, seedExpress } from "./express-fixture";
import { makeFixture, withCwd } from "./fixture";

const F = "--import hoplens/express/register";
const FLAG = "node_modules/.cache/hoplens/path.json";

let fx: ReturnType<typeof makeFixture>;
let out: ReturnType<typeof captureConsole>;
const savedEnv = { HOPLENS_PATH: process.env.HOPLENS_PATH, HOPLENS_OPTIONS: process.env.HOPLENS_OPTIONS };

beforeEach(() => {
  fx = makeFixture();
  out = captureConsole();
  process.exitCode = 0;
  Reflect.deleteProperty(process.env, "HOPLENS_PATH");
  Reflect.deleteProperty(process.env, "HOPLENS_OPTIONS");
});
afterEach(() => {
  out.restore();
  fx.cleanup();
  process.exitCode = 0;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

/** A simulated terminal: `answer` is typed after the question (null: input ends, like Ctrl+D). */
function tty(answer: string | null, interactive = true): PromptIO & { asked: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let asked = "";
  output.on("data", (c) => {
    asked += String(c);
    if (answer === null) input.end();
    else input.write(`${answer}\n`);
  });
  if (!interactive) input.end();
  return { input, output, interactive, asked: () => asked };
}

function project() {
  seedExpress(fx, { scripts: { dev: "node --watch src/server.js" } });
  fx.write("src/server.js", "app.listen(3100);\n");
}

const initIn = (args: string[], io: PromptIO) => withCwd(fx.dir, () => init(args, io));
const flagJson = () => JSON.parse(fx.read(FLAG));

describe("init: the request path question", () => {
  test.each([
    ["y", true],
    ["yes", true],
    ["Y", true],
    ["n", false],
    ["", false],
    ["maybe", false],
  ])("answer %j -> flag %s", async (answer, written) => {
    project();
    const io = tty(answer);
    await initIn([], io);
    expect(io.asked()).toBe(PATH_QUESTION);
    expect(PATH_QUESTION).toBe("Enable request path tracing? (block coverage; slower for CPU-heavy code) [y/N] ");
    expect(fx.exists(FLAG)).toBe(written);
    if (written) {
      expect(flagJson()).toMatchObject({ enabled: true, by: "init" });
      expect(Number.isNaN(Date.parse(flagJson().since))).toBe(false);
      expect(out.text()).toContain(`✓ Enabled request path tracing (${FLAG})`);
    } else expect(out.text()).not.toContain("request path");
    // The script is wired either way.
    expect(JSON.parse(fx.read("package.json")).scripts.dev).toBe(`node --watch ${F} src/server.js`);
  });

  test("input that ends without an answer is no", async () => {
    project();
    await initIn([], tty(null));
    expect(fx.exists(FLAG)).toBe(false);
  });

  test("non-interactive: no question, default off", async () => {
    project();
    const io = tty("y", false);
    await initIn([], io);
    expect(io.asked()).toBe("");
    expect(fx.exists(FLAG)).toBe(false);
  });

  test("--path writes without asking; --no-path removes; both is an error", async () => {
    project();
    const io = tty("n");
    await initIn(["--path"], io);
    expect(io.asked()).toBe("");
    expect(flagJson()).toMatchObject({ enabled: true, by: "init" });
    // Re-run: already on, no question.
    const again = tty("n");
    await initIn([], again);
    expect(again.asked()).toBe("");
    expect(out.text()).toContain("Request path already enabled");
    expect(out.text()).toContain("disable it in the Path view (press x on a request) or with hoplens init --no-path");
    await initIn(["--no-path"], tty("y"));
    expect(fx.exists(FLAG)).toBe(false);
    expect(out.text()).toContain(`✓ Disabled request path tracing (${FLAG})`);
    await initIn(["--path", "--no-path"], tty("y"));
    expect(process.exitCode).toBe(1);
  });

  test("--path non-interactive works (CI)", async () => {
    project();
    await initIn(["--path"], tty(null, false));
    expect(fx.exists(FLAG)).toBe(true);
  });

  test("--dry-run prints the flag and writes nothing (state dir not created)", async () => {
    project();
    const before = fx.read("package.json");
    await initIn(["--dry-run", "--path"], tty(null, false));
    expect(fx.exists("node_modules/.cache/hoplens")).toBe(false);
    expect(fx.read("package.json")).toBe(before);
    expect(out.text()).toContain(`--- ${FLAG} (create)`);
    expect(out.text()).toContain('"enabled":true');
    expect(out.text()).toContain("✓ Would enable request path tracing");
    // An interactive yes under --dry-run: same.
    await initIn(["--dry-run"], tty("y"));
    expect(fx.exists("node_modules/.cache/hoplens")).toBe(false);
  });

  test("HOPLENS_OPTIONS stateDir moves the flag there; remove deletes it there", async () => {
    project();
    process.env.HOPLENS_OPTIONS = JSON.stringify({ stateDir: ".hoplens-state" });
    await initIn(["--path"], tty(null, false));
    expect(fx.exists(".hoplens-state/path.json")).toBe(true);
    expect(fx.exists(FLAG)).toBe(false);
    await withCwd(fx.dir, () => remove([]));
    expect(fx.exists(".hoplens-state/path.json")).toBe(false);
  });
});

describe("init: HOPLENS_PATH overrides the flag", () => {
  test("HOPLENS_PATH=0 in the dev script: no question, no flag, says why", async () => {
    seedExpress(fx, { scripts: { dev: "HOPLENS_PATH=0 node --watch src/server.js" } });
    fx.write("src/server.js", "app.listen(3100);\n");
    const io = tty("y");
    await initIn([], io);
    expect(io.asked()).toBe("");
    expect(fx.exists(FLAG)).toBe(false);
    expect(out.text()).toContain("request path is set by HOPLENS_PATH=0 in scripts.dev");
  });

  test("--path with HOPLENS_PATH=0 in the environment: writes the flag but does not claim Enabled", async () => {
    project();
    process.env.HOPLENS_PATH = "0";
    await initIn(["--path"], tty(null, false));
    expect(fx.exists(FLAG)).toBe(true);
    expect(out.text()).not.toContain("Enabled request path tracing");
    expect(out.text()).toContain("HOPLENS_PATH=0 in the environment");
  });

  test("--no-path with HOPLENS_PATH=1 in the script: removes the flag but does not claim Disabled", async () => {
    seedExpress(fx, { scripts: { dev: "HOPLENS_PATH=1 node --watch src/server.js" } });
    fx.write("src/server.js", "app.listen(3100);\n");
    fx.write(FLAG, JSON.stringify({ enabled: true }));
    await initIn(["--no-path"], tty(null, false));
    expect(fx.exists(FLAG)).toBe(false);
    expect(out.text()).not.toContain("Disabled request path tracing");
    expect(out.text()).toContain("HOPLENS_PATH=1 in scripts.dev");
  });
});

describe("HOPLENS_OPTIONS in the dev script", () => {
  test("init, doctor and remove use the script's stateDir, like the register hook", async () => {
    seedExpress(fx, { scripts: { dev: `HOPLENS_OPTIONS='{"stateDir":".hoplens"}' node --watch src/server.js` } });
    fx.write("src/server.js", "app.listen(3100);\n");
    installFake(fx, "express", "5.1.0");
    installFake(fx, "hoplens", "0.3.1");
    await initIn(["--path"], tty(null, false));
    expect(fx.exists(".hoplens/path.json")).toBe(true);
    expect(fx.exists(FLAG)).toBe(false);
    await withCwd(fx.dir, () => doctor([]));
    expect(out.text()).toContain("disable it in the Path view (press x on a request)");
    expect(out.text()).toContain("• request path: on (flag) — .hoplens/path.json");
    await withCwd(fx.dir, () => remove([]));
    expect(fx.exists(".hoplens/path.json")).toBe(false);
  });

  test("scriptEnv reads the leading assignments (quotes, cross-env), nothing after the command", () => {
    expect(scriptEnv(`HOPLENS_OPTIONS='{"stateDir":".h"}' HOPLENS_PATH=0 node a.js X=1`)).toEqual({
      HOPLENS_OPTIONS: '{"stateDir":".h"}',
      HOPLENS_PATH: "0",
    });
    expect(scriptEnv(`cross-env HOPLENS_OPTIONS="{\\"stateDir\\":\\".h\\"}" node a.js`)).toEqual({
      HOPLENS_OPTIONS: '{"stateDir":".h"}',
    });
    expect(scriptEnv("node --watch a.js")).toEqual({});
    expect(scriptEnv(undefined)).toEqual({});
  });
});

describe("insideDir", () => {
  test("a file on another drive or outside is not inside (Windows cross-drive relative is absolute)", () => {
    const dir = path.resolve("proj", "node_modules", ".cache", "hoplens");
    expect(insideDir(dir, path.join(dir, "path.json"))).toBe(true);
    expect(insideDir(dir, path.resolve("elsewhere", "path.json"))).toBe(false);
    if (process.platform === "win32") {
      const other = /^[cC]/.test(dir) ? "Z:\\x\\path.json" : "C:\\x\\path.json";
      expect(insideDir(dir, other)).toBe(false);
    }
  });
});

describe("remove", () => {
  test("deletes the flag with the state dir (dry-run keeps it)", async () => {
    project();
    await initIn(["--path"], tty(null, false));
    expect(fx.exists(FLAG)).toBe(true);
    await withCwd(fx.dir, () => remove(["--dry-run"]));
    expect(fx.exists(FLAG)).toBe(true);
    await withCwd(fx.dir, () => remove([]));
    expect(fx.exists(FLAG)).toBe(false);
    expect(fx.exists("node_modules/.cache/hoplens")).toBe(false);
  });
});

describe("doctor", () => {
  function healthy(dev = `node --watch ${F} src/server.js`) {
    seedExpress(fx, { scripts: { dev } });
    installFake(fx, "express", "5.1.0");
    installFake(fx, "hoplens", "0.3.1");
  }
  const doctorIn = () => withCwd(fx.dir, () => doctor([]));

  test("on (flag)", async () => {
    healthy();
    fx.write(FLAG, JSON.stringify({ enabled: true, since: "2026-10-19T00:00:00Z", by: "ui" }));
    await doctorIn();
    expect(out.text()).toContain(`• request path: on (flag) — ${FLAG}`);
    expect(process.exitCode).toBe(0);
  });

  test("on (HOPLENS_PATH); HOPLENS_PATH=0 wins over the flag", async () => {
    healthy(`HOPLENS_PATH=1 node --watch ${F} src/server.js`);
    await doctorIn();
    expect(out.text()).toContain("• request path: on (HOPLENS_PATH)");

    out.restore();
    out = captureConsole();
    healthy(`HOPLENS_PATH=0 node --watch ${F} src/server.js`);
    fx.write(FLAG, JSON.stringify({ enabled: true }));
    await doctorIn();
    expect(out.text()).toContain(`• request path: off (HOPLENS_PATH=0 in scripts.dev; it wins over ${FLAG})`);
  });

  test("off", async () => {
    healthy();
    await doctorIn();
    expect(out.text()).toContain("• request path: off");
  });

  test("flag + NODE_V8_COVERAGE warns; a corrupt flag warns", () => {
    const flag = { abs: fx.abs(FLAG), rel: FLAG };
    fx.write(FLAG, JSON.stringify({ enabled: true }));
    const warnings: string[] = [];
    const nope = (s: string) => warnings.push(s);
    doctorPath({ key: "dev", cmd: "node src/server.js" }, { NODE_V8_COVERAGE: "cov" }, { nope }, flag);
    expect(warnings).toEqual([
      `the request path flag (${FLAG}) is set with NODE_V8_COVERAGE (c8) — the request path stays disabled so c8's coverage is not reset; disable one of them`,
    ]);
    // Off by HOPLENS_PATH=0: no c8 warning.
    warnings.length = 0;
    doctorPath(null, { NODE_V8_COVERAGE: "cov", HOPLENS_PATH: "0" }, { nope }, flag);
    expect(warnings).toEqual([]);
    fx.write(FLAG, "{oops");
    doctorPath(null, {}, { nope }, flag);
    expect(warnings[0]).toContain("is not a valid request path flag");
    expect(out.text()).toContain("• request path: off");
  });
});
