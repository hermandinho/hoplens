import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { doctor } from "../src/commands/doctor";
import { doctorPath } from "../src/express/commands";
import { type SeedOptions, captureConsole, installFake, seedExpress } from "./express-fixture";
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

/** A healthy Express project: express 5 and hoplens installed, dev script wired. */
function healthy(opts: SeedOptions = {}) {
  seedExpress(fx, { scripts: { dev: `node --watch ${F} src/server.js`, start: "node src/server.js" }, ...opts });
  installFake(fx, "express", "5.1.0");
  installFake(fx, "hoplens", "0.3.1");
}

const run = (args: string[] = []) => withCwd(fx.dir, () => doctor(args));

describe("hoplens doctor (express)", () => {
  test("healthy project — all set, exit 0", async () => {
    healthy();
    await run();
    const text = out.text();
    expect(text).toContain("✓ Express 5.1.0");
    expect(text).toContain("✓ hoplens runtime is installed");
    expect(text).toContain("✓ scripts.dev loads hoplens/express/register");
    expect(text).toContain("All set.");
    expect(text).not.toContain("next");
    expect(process.exitCode).toBe(0);
  });

  test("Express 4 is supported", async () => {
    healthy();
    installFake(fx, "express", "4.21.2");
    await run();
    expect(out.text()).toContain("✓ Express 4.21.2");
    expect(process.exitCode).toBe(0);
  });

  test("Express 3 — critical", async () => {
    healthy();
    installFake(fx, "express", "3.21.0");
    await run();
    expect(out.text()).toContain("Express 3.21.0 isn't supported");
    expect(process.exitCode).toBe(1);
  });

  test("hoplens not installed — critical with the package manager's command", async () => {
    seedExpress(fx, { scripts: { dev: `node ${F} server.js` } });
    installFake(fx, "express", "5.1.0");
    fx.write("yarn.lock", "");
    await run();
    expect(out.text()).toContain("hoplens runtime is not installed — run yarn add -D hoplens");
    expect(process.exitCode).toBe(1);
  });

  test("@hoplens/express/register without a resolvable @hoplens/express (pnpm) — critical, recommends hoplens/express", async () => {
    seedExpress(fx, { scripts: { dev: "node --import @hoplens/express/register server.js" } });
    installFake(fx, "express", "5.1.0");
    installFake(fx, "hoplens", "0.3.1");
    await run();
    expect(out.text()).toContain("@hoplens/express isn't resolvable from this project (pnpm doesn't hoist it)");
    expect(out.text()).toContain("use hoplens/express/register");
    expect(process.exitCode).toBe(1);
  });

  test("dev script not wired — critical", async () => {
    healthy({ scripts: { dev: "node --watch src/server.js" } });
    await run();
    expect(out.text()).toContain("scripts.dev doesn't load hoplens/express/register — run npx hoplens init");
    expect(process.exitCode).toBe(1);
  });

  test("any supported form counts as wired (-r, nodemon --exec, tsx)", async () => {
    for (const dev of [
      "node -r hoplens/express/register server.js",
      `nodemon --exec "node ${F}" server.js`,
      `tsx watch ${F} src/server.ts`,
    ]) {
      healthy({ scripts: { dev } });
      process.exitCode = 0;
      await run();
      expect(process.exitCode, dev).toBe(0);
    }
  });

  test("register hook in scripts.start — critical", async () => {
    healthy({ scripts: { dev: `node --watch ${F} server.js`, start: `node ${F} server.js` } });
    await run();
    expect(out.text()).toContain("scripts.start loads the Hoplens register hook");
    expect(process.exitCode).toBe(1);
  });

  test("register hook in a production-looking script — critical", async () => {
    healthy({
      scripts: { dev: `node --watch ${F} server.js`, "serve:prod": `NODE_ENV=production node ${F} server.js` },
    });
    await run();
    expect(out.text()).toContain("scripts.serve:prod loads the Hoplens register hook");
    expect(process.exitCode).toBe(1);
  });

  test("start:dev is a dev script, not a production one", async () => {
    healthy({ scripts: { "start:dev": `node --watch ${F} server.js`, start: "node server.js" } });
    await run();
    expect(out.text()).toContain("✓ scripts.start:dev loads");
    expect(process.exitCode).toBe(0);
  });

  test("NODE_OPTIONS in a script or .env — warning, exit 0", async () => {
    healthy({ scripts: { dev: `NODE_OPTIONS='${F}' node --watch server.js` } });
    fx.write(".env.local", `PORT=3000\nNODE_OPTIONS="${F}"\n`);
    await run();
    expect(out.text()).toContain("scripts.dev preloads Hoplens through NODE_OPTIONS");
    expect(out.text()).toContain(".env.local sets NODE_OPTIONS with the Hoplens register hook");
    expect(out.text()).toContain("2 warnings");
    expect(process.exitCode).toBe(0);
  });

  test("NODE_ENV=production in the dev script — warning (gate off)", async () => {
    healthy({ scripts: { dev: `cross-env NODE_ENV=production node ${F} server.js` } });
    await run();
    expect(out.text()).toContain("sets NODE_ENV=production — the dev gate is off");
    expect(process.exitCode).toBe(0);
  });

  test("hoplens(app) in code instead of the hook — info, exit 0", async () => {
    healthy({ scripts: { dev: "node --watch src/server.js" } });
    fx.write(
      "src/server.js",
      `import express from "express";\nimport { hoplens } from "hoplens/express";\nconst app = express();\nhoplens(app);\n`,
    );
    await run();
    expect(out.text()).toContain("• hoplens(app) is called in src/server.js — wired from code");
    expect(process.exitCode).toBe(0);
  });

  test("no dev script and no hoplens(app) — critical", async () => {
    healthy({ scripts: { start: "node server.js" } });
    await run();
    expect(out.text()).toContain("No dev script in package.json");
    expect(process.exitCode).toBe(1);
  });

  test("both next and express without --framework — critical; --framework express runs the Express checks", async () => {
    healthy({ deps: { express: "^5.1.0", next: "^16.0.0" } });
    await run();
    expect(out.text()).toContain("depends on both next and express");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await run(["--framework", "express"]);
    expect(process.exitCode).toBe(0);
  });

  test("neither next nor express — names both frameworks, no Next-only advice", async () => {
    seedExpress(fx, { scripts: { dev: "node server.js" }, deps: {} });
    await run();
    const text = out.text();
    expect(text).toContain("doesn't depend on next or express");
    expect(text).toContain("Hoplens supports Next.js (next) and Express (express)");
    expect(text).not.toContain("next.config");
    expect(text).not.toContain("instrumentation");
    expect(process.exitCode).toBe(1);
  });

  test("a CommonJS entry with exports under --import — info with the -r fix, exit 0; -r or an ES module entry — no note", async () => {
    const entry = "const express = require('express');\nexports.handler = function handler() {};\n";
    healthy();
    fx.write("src/server.js", entry);
    await run();
    expect(out.text()).toContain(
      "src/server.js is a CommonJS entry with exports: under --import Node loads it through its ESM loader",
    );
    expect(out.text()).toContain("preload with -r hoplens/express/register to cover it too");
    expect(process.exitCode).toBe(0);

    out.restore();
    out = captureConsole();
    healthy({ scripts: { dev: "node --watch -r hoplens/express/register src/server.js" } });
    await run();
    expect(out.text()).not.toContain("CommonJS entry");

    out.restore();
    out = captureConsole();
    healthy({ type: "module" });
    fx.write("src/server.js", "import express from 'express';\nexport function handler() {}\n");
    await run();
    expect(out.text()).not.toContain("CommonJS entry");
  });

  test("the CommonJS-entry note: `exports.f = f` counts; under tsx (which wraps the entry) there is no note", async () => {
    healthy({ scripts: { dev: "node --watch --import hoplens/express/register src/server.js" } });
    fx.write("src/server.js", "const express = require('express');\nfunction health() {}\nexports.health = health;\n");
    await run();
    expect(out.text()).toContain("src/server.js is a CommonJS entry with exports");

    for (const dev of [
      "tsx watch --import hoplens/express/register src/server.js",
      "tsx --import hoplens/express/register src/server.js",
      "node --import tsx --import hoplens/express/register src/server.js",
    ]) {
      out.restore();
      out = captureConsole();
      healthy({ scripts: { dev } });
      fx.write("src/server.js", "const express = require('express');\nexports.health = function () {};\n");
      await run();
      expect(out.text(), dev).not.toContain("CommonJS entry");
    }
    // A .cts entry Node strips itself reaches the ESM hook with its source and is wrapped there.
    out.restore();
    out = captureConsole();
    healthy({ scripts: { dev: "node --watch --import hoplens/express/register src/server.cts" } });
    fx.write("src/server.cts", "const express = require('express');\nexports.health = function () {};\n");
    await run();
    expect(out.text()).not.toContain("CommonJS entry");
  });

  test("request path: an info line when HOPLENS_PATH=1 is in the dev script, a warning with NODE_V8_COVERAGE", async () => {
    healthy();
    await run();
    expect(out.text()).toContain(
      "• request path: off — enable it in the Path view (press x on a request) or with hoplens init --path",
    );

    out.restore();
    out = captureConsole();
    healthy({ scripts: { dev: `HOPLENS_PATH=1 node --watch ${F} src/server.js` } });
    await run();
    expect(out.text()).toContain("• request path: on (HOPLENS_PATH) — HOPLENS_PATH=1 in scripts.dev");
    expect(out.text()).not.toContain("NODE_V8_COVERAGE");
    expect(process.exitCode).toBe(0);

    out.restore();
    out = captureConsole();
    healthy({ scripts: { dev: `NODE_V8_COVERAGE=cov HOPLENS_PATH=1 node --watch ${F} src/server.js` } });
    await run();
    expect(out.text()).toContain("! HOPLENS_PATH=1 is set with NODE_V8_COVERAGE (c8)");
    expect(process.exitCode).toBe(0);
  });

  test("request path: HOPLENS_PATH=1 in the environment", () => {
    const warnings: string[] = [];
    doctorPath(null, { HOPLENS_PATH: "1" }, { nope: (s) => warnings.push(s) });
    expect(out.text()).toContain("request path: on (HOPLENS_PATH) — HOPLENS_PATH=1 in the environment");
    expect(warnings).toEqual([]);
    doctorPath(
      { key: "dev", cmd: "c8 node src/server.js" },
      { HOPLENS_PATH: "true" },
      { nope: (s) => warnings.push(s) },
    );
    expect(warnings).toHaveLength(1);
    doctorPath({ key: "dev", cmd: "node src/server.js" }, { NODE_V8_COVERAGE: "x" }, { nope: (s) => warnings.push(s) });
    expect(warnings).toHaveLength(1);
  });
});
