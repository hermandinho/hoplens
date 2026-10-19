// The request path's sticky flag for Next (P6): init asks (TTY only) or takes --path / --no-path and
// writes .next/cache/hoplens/path.json, where @hoplens/next reads it at the first request (the state
// dir core persists to; withHoplens' `stateDir` moves it); doctor reports who turns the path on;
// remove deletes it with the rest of .next/cache/hoplens.
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { doctor } from "../src/commands/doctor";
import { init } from "../src/commands/init";
import { remove } from "../src/commands/remove";
import { PATH_QUESTION } from "../src/express/commands";
import { nextFlagPath } from "../src/next/pathflag";
import type { PromptIO } from "../src/prompt";
import { captureConsole } from "./express-fixture";
import { makeFixture, seedGreenfield, withCwd } from "./fixture";

const FLAG = ".next/cache/hoplens/path.json";

let fx: ReturnType<typeof makeFixture>;
let out: ReturnType<typeof captureConsole>;
const saved = process.env.HOPLENS_PATH;

beforeEach(() => {
  fx = makeFixture();
  out = captureConsole();
  process.exitCode = 0;
  Reflect.deleteProperty(process.env, "HOPLENS_PATH");
  seedGreenfield(fx);
});
afterEach(() => {
  out.restore();
  fx.cleanup();
  process.exitCode = 0;
  if (saved === undefined) Reflect.deleteProperty(process.env, "HOPLENS_PATH");
  else process.env.HOPLENS_PATH = saved;
});

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

const initIn = (args: string[], io: PromptIO = tty(null, false)) => withCwd(fx.dir, () => init(args, io));

describe("hoplens init (Next)", () => {
  test("--path writes the flag in .next/cache/hoplens; --no-path removes it", async () => {
    await initIn(["--path"]);
    expect(JSON.parse(fx.read(FLAG))).toMatchObject({ enabled: true, by: "init" });
    expect(out.text()).toContain(`Enabled request path tracing (${FLAG})`);
    expect(out.text()).not.toMatch(/Express only/);
    await initIn(["--no-path"]);
    expect(fx.exists(FLAG)).toBe(false);
  });

  test("asks in a terminal (default no); no question when not interactive", async () => {
    const no = tty("");
    await initIn([], no);
    expect(no.asked()).toContain(PATH_QUESTION);
    expect(fx.exists(FLAG)).toBe(false);
    const yes = tty("y");
    await initIn([], yes);
    expect(fx.exists(FLAG)).toBe(true);
    fx.cleanup();
    fx = makeFixture();
    seedGreenfield(fx);
    const quiet = tty(null, false);
    await initIn([], quiet);
    expect(quiet.asked()).toBe("");
    expect(fx.exists(FLAG)).toBe(false);
  });

  test("withHoplens' stateDir and next.config's distDir move the flag", async () => {
    fx.write("next.config.ts", `export default withHoplens({ distDir: "build" }, { stateDir: ".hoplens" });\n`);
    expect(nextFlagPath(fx.dir).rel).toBe(".hoplens/path.json");
    fx.write("next.config.ts", `export default withHoplens({ distDir: "build" });\n`);
    expect(nextFlagPath(fx.dir).rel).toBe("build/cache/hoplens/path.json");
  });

  test("HOPLENS_PATH in the dev script wins: no question, --path says the flag has no effect", async () => {
    fx.write(
      "package.json",
      JSON.stringify({ name: "fx", dependencies: { next: "^16.0.0" }, scripts: { dev: "HOPLENS_PATH=0 next dev" } }),
    );
    const io = tty("y");
    await initIn([], io);
    expect(io.asked()).toBe("");
    expect(out.text()).toContain("HOPLENS_PATH=0 in scripts.dev");
    await initIn(["--path"]);
    expect(out.text()).toMatch(/the flag has no effect while it is set/);
  });
});

describe("hoplens doctor / remove (Next)", () => {
  test("doctor reports the flag, then HOPLENS_PATH over it", async () => {
    await withCwd(fx.dir, () => doctor([]));
    expect(out.text()).toContain("request path: off");
    fx.write(FLAG, `${JSON.stringify({ enabled: true, since: "x", by: "ui" })}\n`);
    await withCwd(fx.dir, () => doctor([]));
    expect(out.text()).toContain(`• request path: on (flag) — ${FLAG}`);
    process.env.HOPLENS_PATH = "1";
    await withCwd(fx.dir, () => doctor([]));
    expect(out.text()).toContain("• request path: on (HOPLENS_PATH)");
  });

  test("remove deletes the flag with .next/cache/hoplens", async () => {
    await initIn([]);
    await initIn(["--path"]);
    expect(fx.exists(FLAG)).toBe(true);
    await withCwd(fx.dir, () => remove([]));
    expect(fx.exists(FLAG)).toBe(false);
  });
});
