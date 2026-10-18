import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectFramework, detectPackageManager, frameworkFlag } from "../src/framework";
import { makeFixture } from "./fixture";

describe("detectFramework", () => {
  test("next, express, both, neither", () => {
    expect(detectFramework({ dependencies: { next: "16" } }, undefined)).toEqual({ framework: "next" });
    expect(detectFramework({ devDependencies: { express: "5" } }, undefined)).toEqual({ framework: "express" });
    expect(detectFramework({ dependencies: { next: "16", express: "5" } }, undefined)).toMatchObject({
      error: expect.stringContaining("--framework next or --framework express"),
    });
    expect(detectFramework({ dependencies: {} }, undefined)).toMatchObject({ neither: true });
    expect(detectFramework({ dependencies: { next: "16", express: "5" } }, "express")).toEqual({
      framework: "express",
    });
  });

  test("--framework flag forms", () => {
    expect(frameworkFlag([])).toBeUndefined();
    expect(frameworkFlag(["--framework", "next"])).toBe("next");
    expect(frameworkFlag(["--dry-run", "--framework=express"])).toBe("express");
    expect(frameworkFlag(["--framework"])).toMatchObject({ error: "--framework takes next or express." });
    expect(frameworkFlag(["--framework", "nest"])).toMatchObject({ error: expect.stringContaining("not nest") });
  });
});

describe("detectPackageManager", () => {
  let fx: ReturnType<typeof makeFixture>;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  test("packageManager field, lockfiles, enclosing workspace, default npm", () => {
    fx.write("app/package.json", "{}");
    fx.write("app/.git", "gitdir: elsewhere"); // the walk stops at a repo root
    expect(detectPackageManager(fx.abs("app"))).toBe("npm");
    expect(detectPackageManager(fx.abs("app"), { packageManager: "yarn@4.1.0" })).toBe("yarn");
    fx.write("app/bun.lock", "");
    expect(detectPackageManager(fx.abs("app"))).toBe("bun");
    fx.write("ws/package.json", "{}");
    fx.write("ws/.git/HEAD", "");
    fx.write("ws/pnpm-lock.yaml", "");
    fx.write("ws/apps/api/package.json", "{}");
    expect(detectPackageManager(fx.abs("ws/apps/api"))).toBe("pnpm");
    fx.write("ws/apps/api/.git", "gitdir: elsewhere");
    expect(detectPackageManager(fx.abs("ws/apps/api"))).toBe("npm");
  });
});
