import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { doctor } from "../src/commands/doctor";
import { init } from "../src/commands/init";
import { makeFixture, muteConsole, seedGreenfield, withCwd } from "./fixture";

let fx: ReturnType<typeof makeFixture>;
let unmute: () => void;

/**
 * Doctor reports via `fail()` which sets `process.exitCode = 1`. We reset the global
 * before each test and read it after; vitest doesn't give us a per-test exit sandbox,
 * so this is the pragmatic read.
 */
beforeEach(() => {
  fx = makeFixture();
  unmute = muteConsole();
  process.exitCode = 0;
});
afterEach(() => {
  unmute();
  fx.cleanup();
  process.exitCode = 0;
});

describe("hoplens doctor", () => {
  test("missing package.json — exits with critical failure", async () => {
    // fx.dir has no package.json
    await withCwd(fx.dir, () => doctor([]));
    expect(process.exitCode).toBe(1);
  });

  test("unwired next project — reports critical failures and exits 1", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => doctor([]));
    // No wiring + no installed runtime = criticals
    expect(process.exitCode).toBe(1);
  });

  test("fully wired project — exits 0", async () => {
    seedGreenfield(fx);
    // Fake "installed runtime" presence by seeding node_modules entries that safeResolve
    // can see via require.resolve({ paths: [root] }).
    fx.write("node_modules/next/package.json", JSON.stringify({ name: "next", version: "16.0.0" }));
    fx.write("node_modules/next/index.js", "module.exports = {};");
    fx.write("node_modules/hoplens/package.json", JSON.stringify({ name: "hoplens", version: "0.1.0" }));
    fx.write("node_modules/hoplens/index.js", "module.exports = {};");

    await withCwd(fx.dir, () => init([]));
    await withCwd(fx.dir, () => doctor([]));

    expect(process.exitCode).toBe(0);
  });

  test("warning-only project (missing prod gate) — still exits 0", async () => {
    seedGreenfield(fx);
    fx.write("node_modules/next/package.json", JSON.stringify({ name: "next", version: "16.0.0" }));
    fx.write("node_modules/next/index.js", "module.exports = {};");
    fx.write("node_modules/hoplens/package.json", JSON.stringify({ name: "hoplens", version: "0.1.0" }));
    fx.write("node_modules/hoplens/index.js", "module.exports = {};");

    // Hand-written wiring without the NODE_ENV gate -> warning, not critical.
    fx.write("next.config.ts", `import { withHoplens } from "@hoplens/next";\n\nexport default withHoplens({});\n`);
    fx.write("instrumentation.ts", `export async function register() {\n  await import("@hoplens/next/node");\n}\n`);

    await withCwd(fx.dir, () => doctor([]));
    expect(process.exitCode).toBe(0);
  });
});
