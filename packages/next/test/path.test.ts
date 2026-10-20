// Request path for Next (P6), without a dev server: the flag lives in core's state dir for the app
// (`<distDir>/cache/hoplens`, or withHoplens' stateDir), nothing of the inspector starts while it is
// off, and the analyzer loads @hoplens/transform/cfg with Node's own require (node.ts runs inside
// Next's bundle). The on path, under next dev with both bundlers, is test/path.e2e.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cfgAnalyzer, pathStateDir, startNextPath } from "../src/path";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const opts = (root: string, extra: object = {}) => ({
  port: 1,
  basePath: "",
  distDir: ".next",
  root,
  configured: true,
  ...extra,
});

describe("Next request path", () => {
  test("the flag's state dir is core's persist dir", () => {
    const root = path.resolve("/app");
    expect(pathStateDir(opts(root))).toBe(path.join(root, ".next", "cache", "hoplens"));
    expect(pathStateDir(opts(root, { distDir: "build" }))).toBe(path.join(root, "build", "cache", "hoplens"));
    expect(pathStateDir(opts(root, { stateDir: ".hoplens" }))).toBe(path.join(root, ".hoplens"));
  });

  test("off (no env, no flag): no coverage handle, switch ready; a flag makes it on at the next start", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-next-path-"));
    dirs.push(root);
    const p = startNextPath(opts(root), {});
    expect(p.on).toBe(false);
    expect((globalThis as any)[Symbol.for("hoplens.coverage")]).toBeUndefined();
    expect(p.control.source).toBe("default");
    p.control.enable();
    expect(fs.existsSync(path.join(root, ".next", "cache", "hoplens", "path.json"))).toBe(true);
    expect(p.control.pending()).toBe("on");
    // HOPLENS_PATH=0 wins over the flag without starting anything.
    expect(startNextPath(opts(root), { HOPLENS_PATH: "0" }).on).toBe(false);
    expect((globalThis as any)[Symbol.for("hoplens.coverage")]).toBeUndefined();
  });

  test("the analyzer builds a control-flow model through Node's require", () => {
    const a = cfgAnalyzer(path.resolve(__dirname, ".."));
    const m = a.cfg("x.js", "export function f(a) { if (a) return 1; return 2; }");
    expect(m?.functions.some((f) => f.name === "f")).toBe(true);
  });
});
