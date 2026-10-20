import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FALLBACK_DIRS as EXPRESS_FALLBACK_DIRS } from "../../express/src/autotrace";
import { doctor } from "../src/commands/doctor";
import { FALLBACK_DIRS, runnerView } from "../src/express/hops";
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

  test("FALLBACK_DIRS is the register hook's list", () => {
    expect(FALLBACK_DIRS).toEqual(EXPRESS_FALLBACK_DIRS);
  });
});
