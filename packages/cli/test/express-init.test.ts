import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { init } from "../src/commands/init";
import { captureConsole, devScript, seedExpress } from "./express-fixture";
import { makeFixture, withCwd } from "./fixture";

const F = "--import hoplens/express/register";

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

const run = (args: string[] = []) => withCwd(fx.dir, () => init(args));

describe("hoplens init (express)", () => {
  test("node --watch, ESM — golden output", async () => {
    const before = seedExpress(fx, { type: "module", scripts: { dev: "node --watch src/server.js" } });
    fx.write("src/server.js", "const port = Number(process.env.PORT ?? 3100);\napp.listen(port);\n");
    await run();
    expect(devScript(fx)).toBe(`node --watch ${F} src/server.js`);
    expect(fx.read("package.json")).toBe(before.replace("--watch src", `--watch ${F} src`));
    expect(out.text()).toBe(
      [
        "\n◆ Hoplens init\n",
        `  ✓ Added ${F} to scripts.dev`,
        "\nDone. Run npm run dev and open http://localhost:3100/__hoplens\n",
      ].join("\n"),
    );
    expect(process.exitCode).toBe(0);
  });

  test("node --watch, CommonJS — same flag", async () => {
    seedExpress(fx, { scripts: { dev: "node --watch server.js", start: "node server.js" } });
    fx.write("server.js", "require('express')().listen(4000);\n");
    await run();
    expect(devScript(fx)).toBe(`node --watch ${F} server.js`);
    expect(devScript(fx, "start")).toBe("node server.js");
    expect(out.text()).toContain("open http://localhost:4000/__hoplens");
  });

  const shapes: [string, string, string][] = [
    [
      "node with flags",
      "node --env-file=.env --inspect src/server.js",
      `node ${F} --env-file=.env --inspect src/server.js`,
    ],
    ["tsx watch", "tsx watch src/server.ts", `tsx watch ${F} src/server.ts`],
    [
      "cross-env prefix",
      "cross-env NODE_ENV=development node --watch src/server.js",
      `cross-env NODE_ENV=development node --watch ${F} src/server.js`,
    ],
    ["&& chain", "tsc -p . && node dist/server.js", `tsc -p . && node ${F} dist/server.js`],
    ["nodemon", "nodemon src/server.js", `nodemon --exec "node ${F}" src/server.js`],
  ];
  for (const [name, dev, wired] of shapes) {
    test(`${name}`, async () => {
      seedExpress(fx, { scripts: { dev } });
      await run();
      expect(devScript(fx)).toBe(wired);
      expect(out.text()).toContain(`✓ Added ${F} to scripts.dev`);
      expect(out.text()).toContain("open http://localhost:<your port>/__hoplens");
    });
  }

  test("falls back to start:dev, then watch; never touches start", async () => {
    seedExpress(fx, { scripts: { start: "node server.js", watch: "node --watch server.js" } });
    await run();
    expect(devScript(fx, "watch")).toBe(`node --watch ${F} server.js`);
    expect(devScript(fx, "start")).toBe("node server.js");
    expect(out.text()).toContain("Run npm run watch");
  });

  test("unsupported runner — prints the manual line, edits nothing, exit 0", async () => {
    const before = seedExpress(fx, { scripts: { dev: "ts-node-dev --respawn src/server.ts" } });
    await run();
    expect(fx.read("package.json")).toBe(before);
    expect(out.text()).toBe(
      [
        "\n◆ Hoplens init\n",
        "  ! Didn't edit scripts.dev: ts-node-dev isn't edited automatically. Change it yourself:",
        `\n    "dev": "ts-node-dev -r hoplens/express/register --respawn src/server.ts"\n`,
      ].join("\n"),
    );
    expect(process.exitCode).toBe(0);
  });

  test("no dev script — prints the exact line to add (derived from start), exit 0", async () => {
    const before = seedExpress(fx, { scripts: { start: "node src/server.js" } });
    await run();
    expect(fx.read("package.json")).toBe(before);
    expect(out.text()).toContain(
      `! No dev script in package.json (looked for dev, start:dev, watch). Add one to "scripts":\n\n    "dev": "node --watch ${F} src/server.js"`,
    );
    expect(process.exitCode).toBe(0);
  });

  test("no dev script, production start — the suggestion doesn't copy NODE_ENV=production or dist/", async () => {
    seedExpress(fx, {
      scripts: { start: "cross-env NODE_ENV=production node dist/server.js" },
      extra: { main: "src/server.js" },
    });
    await run();
    expect(out.text()).toContain(`"dev": "node --watch ${F} src/server.js"`);
    expect(out.text()).not.toContain("production node --watch");
    out.restore();
    out = captureConsole();
    seedExpress(fx, { scripts: { start: "node dist/server.js" }, extra: { main: "dist/server.js" } });
    await run();
    expect(out.text()).toContain(`"dev": "node --watch ${F} <your entry file>"`);
  });

  test("no scripts at all — placeholder entry", async () => {
    seedExpress(fx, {});
    await run();
    expect(out.text()).toContain(`"dev": "node --watch ${F} <your entry file>"`);
    expect(process.exitCode).toBe(0);
  });

  test("both next and express without --framework — clear error, exit 1, nothing written", async () => {
    const before = seedExpress(fx, {
      scripts: { dev: "node server.js" },
      deps: { express: "^5.0.0", next: "^16.0.0" },
    });
    await run();
    expect(process.exitCode).toBe(1);
    expect(out.text()).toContain("depends on both next and express");
    expect(out.text()).toContain("--framework next or --framework express");
    expect(fx.read("package.json")).toBe(before);
    expect(fx.exists("next.config.mjs")).toBe(false);
  });

  test("both, with --framework express — wires express", async () => {
    seedExpress(fx, { scripts: { dev: "node server.js" }, deps: { express: "^5.0.0", next: "^16.0.0" } });
    await run(["--framework", "express"]);
    expect(devScript(fx)).toBe(`node ${F} server.js`);
    expect(fx.exists("next.config.mjs")).toBe(false);
  });

  test("--framework with a bad value fails", async () => {
    seedExpress(fx, { scripts: { dev: "node server.js" } });
    await run(["--framework=nest"]);
    expect(process.exitCode).toBe(1);
    expect(out.text()).toContain("--framework takes next or express, not nest");
  });

  test("neither next nor express — error names both", async () => {
    fx.write("package.json", JSON.stringify({ name: "x", dependencies: { koa: "^2" } }));
    await run();
    expect(process.exitCode).toBe(1);
    expect(out.text()).toContain("doesn't depend on next or express");
  });

  test("idempotent — second run says already wired, writes nothing", async () => {
    seedExpress(fx, { scripts: { dev: "node --watch src/server.js" } });
    await run();
    const first = fx.read("package.json");
    await run();
    expect(fx.read("package.json")).toBe(first);
    expect(out.text()).toContain("scripts.dev already wired (loads hoplens/express/register)");
  });

  test("--dry-run prints a diff and writes nothing", async () => {
    const before = seedExpress(fx, { scripts: { dev: "node --watch src/server.js" } });
    await run(["--dry-run"]);
    expect(fx.read("package.json")).toBe(before);
    expect(out.text()).toContain(
      `--- package.json\n-     "dev": "node --watch src/server.js"\n+     "dev": "node --watch ${F} src/server.js"`,
    );
    expect(out.text()).toContain(`Would add ${F} to scripts.dev`);
  });

  test("preserves CRLF, 4-space indent and key order", async () => {
    const before = seedExpress(fx, { scripts: { dev: "nodemon src/server.js", build: "tsc" }, indent: 4, crlf: true });
    await run();
    const after = fx.read("package.json");
    expect(after).toBe(
      before.replace("nodemon src", 'nodemon --exec \\"node --import hoplens/express/register\\" src'),
    );
    expect(after.endsWith("}\r\n")).toBe(true);
  });

  test("install hint uses the project's package manager", async () => {
    seedExpress(fx, { scripts: { dev: "node server.js" }, devDeps: {} });
    fx.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await run();
    expect(out.text()).toContain("Install the runtime: pnpm add -D hoplens");
    expect(out.text()).toContain("Run pnpm run dev");
  });
});
