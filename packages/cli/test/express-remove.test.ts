import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { init } from "../src/commands/init";
import { remove } from "../src/commands/remove";
import { captureConsole, devScript, seedExpress } from "./express-fixture";
import { makeFixture, withCwd } from "./fixture";

let fx: ReturnType<typeof makeFixture>;
let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  fx = makeFixture();
  out = captureConsole();
  process.exitCode = 0;
});
afterEach(() => {
  out.restore();
  fx.cleanup();
  process.exitCode = 0;
});

const initIn = (args: string[] = []) => withCwd(fx.dir, () => init(args));
const removeIn = (args: string[] = []) => withCwd(fx.dir, () => remove(args));

describe("hoplens remove (express)", () => {
  const scripts = [
    "node --watch src/server.js",
    "node --env-file=.env --inspect src/server.js",
    "tsx watch src/server.ts",
    "cross-env NODE_ENV=development node --watch src/server.js",
    "tsc -p . && node dist/server.js",
    "nodemon src/server.js",
    'nodemon --watch src --exec "node --inspect" src/server.js',
  ];
  for (const dev of scripts) {
    for (const layout of [
      { indent: 2, crlf: false },
      { indent: 4, crlf: true },
    ]) {
      test(`init -> remove is byte-exact: ${dev} (indent ${layout.indent}${layout.crlf ? ", CRLF" : ""})`, async () => {
        const before = seedExpress(fx, { scripts: { build: "tsc", dev, start: "node dist/server.js" }, ...layout });
        await initIn();
        expect(fx.read("package.json")).not.toBe(before);
        await removeIn();
        expect(fx.read("package.json")).toBe(before);
      });
    }
  }

  test("deletes node_modules/.cache/hoplens, keeps the rest of the cache", async () => {
    seedExpress(fx, { scripts: { dev: "node --watch server.js" } });
    await initIn();
    fx.write("node_modules/.cache/hoplens/facts.ndjson", "{}\n");
    fx.write("node_modules/.cache/other/keep.txt", "x");
    await removeIn();
    expect(fx.exists("node_modules/.cache/hoplens")).toBe(false);
    expect(fx.exists("node_modules/.cache/other/keep.txt")).toBe(true);
    expect(out.text()).toContain("Deleted node_modules");
    expect(out.text()).toContain("uninstall it: npm rm hoplens");
  });

  test("keeps the hoplens devDependency (as the Next remove does)", async () => {
    seedExpress(fx, { scripts: { dev: "node server.js" } });
    await initIn();
    await removeIn();
    expect(JSON.parse(fx.read("package.json")).devDependencies.hoplens).toBe("^0.3.0");
  });

  test("--dry-run prints the diff and the delete, writes nothing", async () => {
    seedExpress(fx, { scripts: { dev: "node --watch server.js" } });
    await initIn();
    fx.write("node_modules/.cache/hoplens/facts.ndjson", "{}\n");
    const wired = fx.read("package.json");
    await removeIn(["--dry-run"]);
    expect(fx.read("package.json")).toBe(wired);
    expect(fx.exists("node_modules/.cache/hoplens/facts.ndjson")).toBe(true);
    expect(out.text()).toContain(
      '--- package.json\n-     "dev": "node --watch --import hoplens/express/register server.js"\n+     "dev": "node --watch server.js"',
    );
    expect(out.text()).toMatch(/--- node_modules[\\/].cache[\\/]hoplens \(delete\)/);
  });

  test("a hand-written -r form is left alone with a warning", async () => {
    const before = seedExpress(fx, { scripts: { dev: "node -r hoplens/express/register server.js" } });
    await removeIn();
    expect(fx.read("package.json")).toBe(before);
    expect(out.text()).toContain("in a form init didn't write. Remove it by hand.");
    expect(out.text()).not.toContain("isn't wired into this project");
    expect(out.text()).toContain("Nothing removed automatically");
  });

  test("idempotent — second remove is a no-op", async () => {
    seedExpress(fx, { scripts: { dev: "node server.js" } });
    await initIn();
    await removeIn();
    const after = fx.read("package.json");
    await removeIn();
    expect(fx.read("package.json")).toBe(after);
    expect(devScript(fx)).toBe("node server.js");
    expect(out.text()).toContain("Nothing to remove");
  });

  test("both next and express without --framework — exit 1, nothing touched", async () => {
    const before = seedExpress(fx, {
      scripts: { dev: "node --import hoplens/express/register server.js" },
      deps: { express: "^5.0.0", next: "^16.0.0" },
    });
    await removeIn();
    expect(process.exitCode).toBe(1);
    expect(fx.read("package.json")).toBe(before);
    await removeIn(["--framework", "express"]);
    expect(devScript(fx)).toBe("node server.js");
  });
});
