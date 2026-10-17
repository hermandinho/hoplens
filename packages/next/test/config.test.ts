import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { withHoplens } from "../src/index";

const DEV = "phase-development-server";
let withPg: string;
let withoutPg: string;

// pnpm's bin shims put its virtual store on NODE_PATH, where `postgres` (a core devDependency)
// resolves from any directory. Rebuild Node's global lookup paths without it.
const Module = require("node:module");
const nodePath = process.env.NODE_PATH;

beforeAll(() => {
  Reflect.deleteProperty(process.env, "NODE_PATH");
  Module._initPaths();
  withoutPg = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-cfg-"));
  fs.writeFileSync(path.join(withoutPg, "package.json"), "{}");
  withPg = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-cfg-pg-"));
  fs.writeFileSync(path.join(withPg, "package.json"), "{}");
  const pkg = path.join(withPg, "node_modules", "postgres");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "postgres", main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = {};");
});

afterEach(() => {
  vi.restoreAllMocks();
  // withHoplens hands its options to the runtime through these.
  Reflect.deleteProperty(process.env, "HOPLENS_ENABLED");
  Reflect.deleteProperty(process.env, "HOPLENS_OPTIONS");
});

afterAll(() => {
  if (nodePath !== undefined) process.env.NODE_PATH = nodePath;
  Module._initPaths();
  fs.rmSync(withPg, { recursive: true, force: true });
  fs.rmSync(withoutPg, { recursive: true, force: true });
});

async function externals(root: string, config: Record<string, any> = {}) {
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const out = await withHoplens(config)(DEV, {});
  return out.serverExternalPackages as string[];
}

describe("serverExternalPackages in dev", () => {
  test("adds postgres when the app can resolve it, keeping the app's own entries", async () => {
    expect(await externals(withPg, { serverExternalPackages: ["sharp", "postgres"] })).toEqual([
      "sharp",
      "postgres",
      "@hoplens/core",
    ]);
    expect(await externals(withPg)).toEqual(["@hoplens/core", "postgres"]);
  });

  test("leaves postgres out when the app doesn't have it", async () => {
    expect(await externals(withoutPg)).toEqual(["@hoplens/core"]);
  });

  test("leaves postgres out when the app transpiles it (Next rejects a package in both lists)", async () => {
    expect(await externals(withPg, { transpilePackages: ["postgres"] })).toEqual(["@hoplens/core"]);
  });
});
