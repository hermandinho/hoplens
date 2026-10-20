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

// pnpm does not hoist transitive dependencies: `@hoplens/transform` and `@hoplens/ui` are deps of
// the adapter (and of core), not of the app, so a bare specifier resolved from the project root
// fails. Turbopack then reports "Could not parse module '[project]/instrumentation.ts', file not
// found" and webpack throws "Cannot find module '@hoplens/transform/loader'".
describe("loader and UI paths when the app root can't see Hoplens' own dependencies (pnpm)", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-cfg-pnpm-"));
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    const next = path.join(root, "node_modules", "next");
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, "package.json"), JSON.stringify({ name: "next", version: "16.4.0" }));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  afterEach(() => Reflect.deleteProperty(process.env, "HOPLENS_UI_PATH"));

  async function config() {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect(() => require.resolve("@hoplens/transform/loader", { paths: [root] })).toThrow();
    return withHoplens({})(DEV, {});
  }

  test("the Turbopack rule names the loader by an absolute path that exists", async () => {
    const out = await config();
    const rule = Object.values(out.turbopack.rules as Record<string, any>)[0];
    const loader = rule.loaders[0].loader as string;
    expect(path.isAbsolute(loader)).toBe(true);
    expect(fs.existsSync(loader)).toBe(true);
  });

  test("the webpack rule resolves the loader without throwing", async () => {
    const out = await config();
    const cfg = out.webpack({ module: { rules: [] } }, { isServer: true, nextRuntime: "nodejs" });
    const loader = cfg.module.rules[0].use[0].loader as string;
    expect(path.isAbsolute(loader)).toBe(true);
    expect(fs.existsSync(loader)).toBe(true);
  });

  test("the UI HTML path is found through core", async () => {
    await config();
    expect(process.env.HOPLENS_UI_PATH && fs.existsSync(process.env.HOPLENS_UI_PATH)).toBe(true);
  });
});
