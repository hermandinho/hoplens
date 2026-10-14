import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { init } from "../src/commands/init";
import { remove } from "../src/commands/remove";
import { makeFixture, muteConsole, seedGreenfield, withCwd } from "./fixture";

let fx: ReturnType<typeof makeFixture>;
let unmute: () => void;

beforeEach(() => {
  fx = makeFixture();
  unmute = muteConsole();
});
afterEach(() => {
  unmute();
  fx.cleanup();
});

describe("hoplens remove", () => {
  test("greenfield init → remove — byte-identical empty state", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => init([]));
    expect(fx.exists("next.config.ts")).toBe(true);
    expect(fx.exists("instrumentation.ts")).toBe(true);

    await withCwd(fx.dir, () => remove([]));
    // Both files were created by init with nothing user-authored, so remove deletes them.
    expect(fx.exists("next.config.ts")).toBe(false);
    expect(fx.exists("instrumentation.ts")).toBe(false);
  });

  test("TS config round-trip — matches original byte-for-byte", async () => {
    seedGreenfield(fx);
    const before = `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n`;
    fx.write("next.config.ts", before);
    await withCwd(fx.dir, () => init([]));
    await withCwd(fx.dir, () => remove([]));
    expect(fx.read("next.config.ts")).toBe(before);
  });

  test("CJS config round-trip — matches original byte-for-byte", async () => {
    seedGreenfield(fx);
    const before = `/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\n\nmodule.exports = nextConfig;\n`;
    fx.write("next.config.js", before);
    await withCwd(fx.dir, () => init([]));
    await withCwd(fx.dir, () => remove([]));
    expect(fx.read("next.config.js")).toBe(before);
  });

  test("user-owned instrumentation round-trip — user code preserved", async () => {
    seedGreenfield(fx);
    const before = `import { setupOtel } from "./lib/otel";\n\nexport async function register() {\n  await setupOtel();\n}\n`;
    fx.write("instrumentation.ts", before);
    await withCwd(fx.dir, () => init([]));
    await withCwd(fx.dir, () => remove([]));
    expect(fx.read("instrumentation.ts")).toBe(before);
  });

  test("idempotent — second remove is a no-op", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => init([]));
    await withCwd(fx.dir, () => remove([]));

    // Running remove again must not throw or write anything new.
    await expect(withCwd(fx.dir, () => remove([]))).resolves.toBeUndefined();
    expect(fx.exists("next.config.ts")).toBe(false);
    expect(fx.exists("instrumentation.ts")).toBe(false);
  });

  test("--dry-run — does not touch files", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => init([]));
    const configBefore = fx.read("next.config.ts");
    const insBefore = fx.read("instrumentation.ts");

    await withCwd(fx.dir, () => remove(["--dry-run"]));
    expect(fx.read("next.config.ts")).toBe(configBefore);
    expect(fx.read("instrumentation.ts")).toBe(insBefore);
  });

  test("unwired project — nothing to remove, no error", async () => {
    seedGreenfield(fx);
    await expect(withCwd(fx.dir, () => remove([]))).resolves.toBeUndefined();
  });
});
