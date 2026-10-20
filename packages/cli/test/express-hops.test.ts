import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FALLBACK_DIRS as EXPRESS_FALLBACK_DIRS } from "../../express/src/autotrace";
import { doctor } from "../src/commands/doctor";
import { FALLBACK_DIRS, appNodeVersion, nodeLines, runnerView, specStripsTypes } from "../src/express/hops";
import { captureConsole, installFake, seedExpress } from "./express-fixture";
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

function project(dev: string | null, opts: { src?: boolean } = {}) {
  seedExpress(fx, dev ? { scripts: { dev } } : {});
  installFake(fx, "express", "5.1.0");
  installFake(fx, "hoplens", "0.3.1");
  if (opts.src !== false) fx.write("src/server.js", "import express from 'express';\n");
}

const run = () => withCwd(fx.dir, () => doctor([]));
/** The Function hops section's lines (up to the summary). */
const section = () => {
  const t = out.text();
  const at = t.indexOf("  Function hops");
  if (at < 0) return "";
  const end = t.indexOf("\n\n", t.indexOf("\n", at) + 1);
  return t.slice(at, end < 0 ? undefined : end);
};

describe("hoplens doctor: Function hops (express)", () => {
  test("default: on for src/**, node --import RAW, an empty cache, the skip-files hint; all set", async () => {
    project(`node --watch ${F} src/server.js`);
    await run();
    const s = section();
    expect(s).toContain("• function hops: on by default — the exported functions of src/**");
    expect(s).toContain(
      "• runner: node --import — ES modules (and TypeScript Node strips itself) are rewritten as on disk (RAW)",
    );
    expect(s).toContain("• transform cache: node_modules/.cache/hoplens/transform (empty until the app starts)");
    expect(s).toContain(`skip files: HOPLENS_OPTIONS='{"autoTrace":{"exclude":["src/generated/**"]}}'`);
    expect(s).toContain("HOPLENS_DEBUG=transform prints each file");
    expect(out.text()).toContain("All set.");
    expect(process.exitCode).toBe(0);
  });

  test("the cache's size, a moved state dir, and the cache turned off", async () => {
    project(`HOPLENS_OPTIONS='{"stateDir":".hl"}' node ${F} src/server.js`);
    fx.write(".hl/transform/a.hlc", "x".repeat(1000));
    fx.write(".hl/transform/b.hlc", "x".repeat(1100));
    fx.write(".hl/transform/c.hlc.1.tmp", "x");
    fx.write(".hl/transform/evict.stamp", "");
    await run();
    expect(section()).toContain(
      "• transform cache: .hl/transform (2 files, 2 KB) — a restart with unchanged files loads no TypeScript",
    );

    for (const [dev, why] of [
      [`HOPLENS_TRANSFORM_CACHE=0 node ${F} src/server.js`, "HOPLENS_TRANSFORM_CACHE=0 in scripts.dev"],
      [
        `HOPLENS_OPTIONS='{"transformCache":false}' node ${F} src/server.js`,
        "transformCache: false in HOPLENS_OPTIONS in scripts.dev",
      ],
    ]) {
      out.restore();
      out = captureConsole();
      project(dev!);
      await run();
      expect(section(), dev).toContain(
        `• transform cache: off (${why}) — every start parses each file with TypeScript`,
      );
    }

    out.restore();
    out = captureConsole();
    project(`node ${F} src/server.js`);
    const prev = process.env.HOPLENS_TRANSFORM_CACHE;
    process.env.HOPLENS_TRANSFORM_CACHE = "off";
    try {
      await run();
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "HOPLENS_TRANSFORM_CACHE");
      else process.env.HOPLENS_TRANSFORM_CACHE = prev;
    }
    expect(section()).toContain("transform cache: off (HOPLENS_TRANSFORM_CACHE=off in the environment)");
  });

  test.each([
    [`HOPLENS_AUTOTRACE=0 node ${F} src/server.js`, "function hops: off (HOPLENS_AUTOTRACE=0 in scripts.dev)"],
    [
      `HOPLENS_OPTIONS='{"autoTrace":false}' node ${F} src/server.js`,
      "function hops: off (autoTrace: false in HOPLENS_OPTIONS in scripts.dev)",
    ],
    [
      `HOPLENS_OPTIONS='{"enabled":false}' node ${F} src/server.js`,
      "function hops: off (enabled: false in HOPLENS_OPTIONS in scripts.dev)",
    ],
  ])("%s: off, and from where; nothing else listed", async (dev, line) => {
    project(dev);
    await run();
    expect(section()).toContain(line);
    expect(section()).not.toContain("runner:");
    expect(section()).not.toContain("transform cache");
  });

  test("autoTrace include / exclude from HOPLENS_OPTIONS; the fallback dirs without src/; nothing in scope", async () => {
    project(`HOPLENS_OPTIONS='{"autoTrace":{"include":["lib/**"],"exclude":["lib/gen/**"]}}' node ${F} index.js`);
    await run();
    expect(section()).toContain(
      "function hops: on (autoTrace in HOPLENS_OPTIONS in scripts.dev) — the exported functions of lib/**, except lib/gen/**",
    );

    out.restore();
    out = captureConsole();
    fx.cleanup();
    fx = makeFixture();
    project(`node ${F} index.js`, { src: false });
    fx.write("routes/a.js", "");
    fx.write("lib/b.js", "");
    await run();
    expect(section()).toContain("function hops: on by default — the exported functions of lib/**, routes/**");

    out.restore();
    out = captureConsole();
    fx.cleanup();
    fx = makeFixture();
    project(`node ${F} index.js`, { src: false });
    await run();
    expect(section()).toContain(
      "function hops: on by default, but nothing is in scope (no src/ and none of app, pages, lib, server, ...)",
    );
    expect(process.exitCode).toBe(0);
  });

  test.each([
    [
      `tsx watch ${F} src/server.ts`,
      "runner: tsx, then Hoplens — tsx compiles each .ts/.mts first and Hoplens maps its output back to the source (COMPILED)",
    ],
    [`node --import tsx ${F} src/server.ts`, "runner: tsx, then Hoplens"],
    [
      `node ${F} --import tsx src/server.ts`,
      "runner: Hoplens, then tsx — Hoplens rewrites each file as it is on disk (RAW)",
    ],
    [
      "node --watch -r hoplens/express/register src/server.js",
      "runner: node -r — CommonJS modules, the entry included, go through the CommonJS layer",
    ],
    ["node -r ts-node/register -r hoplens/express/register src/server.ts", "runner: ts-node (CommonJS)"],
  ])("%s", async (dev, line) => {
    project(dev);
    await run();
    expect(section()).toContain(line);
    expect(process.exitCode).toBe(0);
    expect(out.text()).toContain("All set.");
  });

  test("ts-node's ESM loader: untested, a warning (exit 0)", async () => {
    project(`node --loader ts-node/esm ${F} src/server.ts`);
    await run();
    expect(section()).toContain("runner: ts-node's ESM loader");
    expect(section()).toContain("! ts-node's ESM loader is untested with function hops");
    expect(out.text()).toContain("1 warning");
    expect(process.exitCode).toBe(0);
  });

  test("a CommonJS entry under --import is listed in this section, by its refusal reason", async () => {
    project(`node ${F} src/server.js`);
    fx.write("src/server.js", "const express = require('express');\nexports.handler = function handler() {};\n");
    await run();
    expect(section()).toContain(
      "src/server.js is a CommonJS entry with exports: under --import Node loads it through its ESM loader, so its own functions get no function hops (refused=esm-loader;",
    );
  });

  test("hoplens(app) in code without the register hook: off, with the fix; no dev script: no section", async () => {
    seedExpress(fx, { scripts: { dev: "node src/server.js" } });
    installFake(fx, "express", "5.1.0");
    installFake(fx, "hoplens", "0.3.1");
    fx.write("src/server.js", "const { hoplens } = require('hoplens/express');\nhoplens(app);\n");
    await run();
    expect(section()).toContain(
      "function hops: off — hoplens(app) runs after your modules loaded; load hoplens/express/register",
    );

    out.restore();
    out = captureConsole();
    fx.cleanup();
    fx = makeFixture();
    project(null);
    await run();
    expect(section()).toBe("");
  });

  test("runnerView reads the order of the preloads", () => {
    expect(runnerView(`node ${F} app.js`)).toEqual({ kind: "node", preload: "import" });
    expect(runnerView("node --require hoplens/express/register app.js")).toEqual({ kind: "node", preload: "require" });
    expect(runnerView(`node --import=tsx ${F} app.ts`)).toEqual({ kind: "tsx-first" });
    expect(runnerView(`node ${F} --import=tsx app.ts`)).toEqual({ kind: "hoplens-first" });
    expect(runnerView(`npx tsx ${F} app.ts`)).toEqual({ kind: "tsx-first" });
    // Node runs every -r before any --import: a -r register hook is registered first (RAW), wherever it sits.
    expect(runnerView("node --import tsx -r hoplens/express/register src/server.ts")).toEqual({
      kind: "hoplens-first",
    });
    expect(runnerView("node -r hoplens/express/register --import tsx src/server.ts")).toEqual({
      kind: "hoplens-first",
    });
    expect(runnerView("tsx watch -r hoplens/express/register src/server.ts")).toEqual({ kind: "hoplens-first" });
    expect(runnerView("tsx watch --require=hoplens/express/register src/server.ts")).toEqual({
      kind: "hoplens-first",
    });
    expect(runnerView("ts-node-esm app.ts")).toEqual({ kind: "ts-node-esm" });
    expect(runnerView("ts-node --esm app.ts")).toEqual({ kind: "ts-node-esm" });
  });

  test("nodeLines: plain node on a .ts entry is judged by the app's pinned Node, not the doctor's", () => {
    const n20 = { version: "v20.9.0", stripsTypes: false, hookApi: "async" as const, importOrdered: false };
    const n24 = { version: "v24.22.0", stripsTypes: true, hookApi: "sync" as const, importOrdered: true };
    const plainTs = `node ${F} src/server.ts`;
    const fix = "run it with tsx (tsx --import hoplens/express/register src/server.ts)";
    // Pinned below type stripping: an error naming the pin, whatever Node runs the doctor.
    for (const n of [n20, n24])
      expect(nodeLines(plainTs, runnerView(plainTs), n, { spec: "20.9.0", from: ".nvmrc" })).toMatchObject({
        nope: [
          `src/server.ts is TypeScript and the app's Node (20.9.0, from .nvmrc) does not strip types (22.18+ does by default, 22.6+ with --experimental-strip-types) — ${fix} or a newer Node`,
        ],
        warn: [],
      });
    // Pinned at or above 22.18: nothing to say, even when the doctor runs on 20.9.
    expect(
      nodeLines(plainTs, runnerView(plainTs), n20, { spec: ">=22.18", from: "package.json engines.node" }),
    ).toMatchObject({ nope: [], warn: [] });
    // Not pinned: a warning naming 22.18+, never an error, on either doctor Node.
    for (const n of [n20, n24])
      expect(nodeLines(plainTs, runnerView(plainTs), n)).toMatchObject({
        nope: [],
        warn: [
          `src/server.ts is TypeScript under plain node: that needs Node 22.18+ (22.6+ with --experimental-strip-types), and the project pins no Node version (engines.node, .nvmrc, .node-version) — on an older Node, ${fix}`,
        ],
      });
    // A range that allows both: a warning quoting it.
    expect(
      nodeLines(plainTs, runnerView(plainTs), n24, { spec: ">=20.9", from: "package.json engines.node" }).warn[0],
    ).toContain(", and package.json engines.node allows >=20.9 — on an older Node");
    // Stripping turned off: an error on any Node.
    const noStrip = `node --no-experimental-strip-types ${F} src/server.ts`;
    expect(nodeLines(noStrip, runnerView(noStrip), n24, { spec: "24", from: ".nvmrc" }).nope[0]).toContain(
      "runs node with --no-experimental-strip-types",
    );
    // A loader in the command or in NODE_OPTIONS: Node does not run the .ts itself.
    for (const cmd of [
      `node -r @swc-node/register ${F} src/server.ts`,
      `node -r esbuild-register ${F} src/server.ts`,
      `node --experimental-strip-types ${F} src/server.ts`,
      `node --experimental-transform-types ${F} src/server.ts`,
      `NODE_OPTIONS="--import tsx" node ${F} src/server.ts`,
    ])
      expect(nodeLines(cmd, runnerView(cmd), n20, { spec: "20.9.0", from: ".nvmrc" }), cmd).toMatchObject({
        nope: [],
        warn: [],
      });
    expect(
      nodeLines(
        plainTs,
        runnerView(plainTs),
        n20,
        { spec: "20.9.0", from: ".nvmrc" },
        { NODE_OPTIONS: "--import tsx" },
      ),
    ).toMatchObject({ nope: [], warn: [] });
    // An unrecognised runner falls back to kind "node": an info line, never an error or a warning.
    for (const cmd of [`bun ${F} src/server.ts`, `my-runner ${F} src/server.ts`]) {
      expect(runnerView(cmd).kind).toBe("node");
      const says = nodeLines(cmd, runnerView(cmd), n20, { spec: "20.9.0", from: ".nvmrc" });
      expect(says.nope, cmd).toEqual([]);
      expect(says.warn, cmd).toEqual([]);
      expect(says.note[1], cmd).toContain(
        "src/server.ts is TypeScript and the doctor does not recognise the dev script's runner",
      );
    }
    // Plain JS on 20.9: nothing to say beyond the hook API.
    const js = `node ${F} src/server.js`;
    expect(nodeLines(js, runnerView(js), n20)).toEqual({
      nope: [],
      warn: [],
      note: ["Node v20.9.0: the ESM hook runs in Node's hooks worker (module.register)"],
    });
    const tsxFirst = `node --import tsx ${F} src/server.ts`;
    expect(nodeLines(tsxFirst, runnerView(tsxFirst), n20).note[1]).toContain(
      "Node v20.9.0 runs `--import tsx` after Hoplens' hook (20.9 / 20.10 do not keep --import order; 20.11+ do)",
    );
    expect(nodeLines(tsxFirst, runnerView(tsxFirst), n24).note).toEqual([
      "Node v24.22.0: the ESM hook runs in-thread (module.registerHooks, as tsx's does on this Node); a cold start parses on the main thread, a warm one answers from the transform cache",
    ]);
    // The tsx CLI runs the entry itself: no stripping needed.
    const cli = `tsx ${F} src/server.ts`;
    expect(nodeLines(cli, runnerView(cli), n20)).toMatchObject({ nope: [], warn: [] });
  });

  test("specStripsTypes reads exact pins, ranges and LTS names", () => {
    for (const s of ["24", "v24.1.0", "22.18.0", "^22.18", ">=22.18", ">=23.6", "lts/krypton", "~22.19", "22.18.x"])
      expect(specStripsTypes(s), s).toBe("yes");
    for (const s of ["20.9.0", "v20", "20.x", "^20.9.0", "<22", "22.17", "23.3.0", "lts/iron", "lts/jod", "18 || 20"])
      expect(specStripsTypes(s), s).toBe("no");
    for (const s of [">=20.9", "22", "^22.0.0", "*", "node", "lts/*", "latest", "20 || 24", "garbage"])
      expect(specStripsTypes(s), s).toBe("unknown");
  });

  test("appNodeVersion: volta, then .node-version, then .nvmrc, then engines.node", () => {
    seedExpress(fx, { extra: { engines: { node: ">=20.9" } } });
    expect(appNodeVersion(fx.dir)).toEqual({ spec: ">=20.9", from: "package.json engines.node" });
    fx.write(".nvmrc", "# pinned\nv20.9.0\n");
    expect(appNodeVersion(fx.dir)).toEqual({ spec: "v20.9.0", from: ".nvmrc" });
    fx.write(".node-version", "24.22.0\n");
    expect(appNodeVersion(fx.dir)).toEqual({ spec: "24.22.0", from: ".node-version" });
    seedExpress(fx, { extra: { volta: { node: "22.18.0" } } });
    expect(appNodeVersion(fx.dir)).toEqual({ spec: "22.18.0", from: "package.json volta.node" });
  });

  test("doctor: plain node on a .ts entry with a too-old pinned Node is critical; unpinned is a warning", async () => {
    project(`node ${F} src/server.ts`);
    fx.write(".nvmrc", "20.9.0\n");
    await run();
    expect(section()).toContain("✗ src/server.ts is TypeScript and the app's Node (20.9.0, from .nvmrc)");
    expect(process.exitCode).toBe(1);

    out.restore();
    fx.cleanup();
    fx = makeFixture();
    out = captureConsole();
    process.exitCode = 0;
    project(`node ${F} src/server.ts`);
    await run();
    expect(section()).toContain("! src/server.ts is TypeScript under plain node: that needs Node 22.18+");
    expect(section()).not.toContain("✗ src/server.ts");
  });

  test("doctor: an unrecognised runner on a .ts entry is an info line", async () => {
    project(`my-runner ${F} src/server.ts`);
    fx.write(".nvmrc", "20.9.0\n");
    await run();
    expect(section()).toContain("• src/server.ts is TypeScript and the doctor does not recognise");
    expect(section()).not.toContain("! src/server.ts");
    expect(section()).not.toContain("✗ src/server.ts");
  });

  test("FALLBACK_DIRS is the register hook's list", () => {
    expect(FALLBACK_DIRS).toEqual(EXPRESS_FALLBACK_DIRS);
  });
});
