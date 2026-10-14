import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { init } from "../src/commands/init";
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

describe("hoplens init", () => {
  test("greenfield project — creates next.config.ts and instrumentation.ts", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => init([]));

    expect(fx.exists("next.config.ts")).toBe(true);
    expect(fx.read("next.config.ts")).toMatch(/withHoplens/);
    expect(fx.read("next.config.ts")).toMatch(/import \{ withHoplens \} from "@hoplens\/next"/);

    expect(fx.exists("instrumentation.ts")).toBe(true);
    const ins = fx.read("instrumentation.ts");
    expect(ins).toMatch(/export async function register/);
    expect(ins).toMatch(/@hoplens\/next\/node/);
    expect(ins).toMatch(/NODE_ENV === "development"/);
  });

  test("existing TS next.config — wraps default export, adds import", async () => {
    seedGreenfield(fx);
    fx.write(
      "next.config.ts",
      `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n`,
    );
    await withCwd(fx.dir, () => init([]));

    const out = fx.read("next.config.ts");
    expect(out).toContain(`import { withHoplens } from "@hoplens/next"`);
    expect(out).toContain("export default withHoplens(nextConfig)");
    // user content is preserved
    expect(out).toContain("reactStrictMode: true");
  });

  test("existing CJS next.config — wraps module.exports with require", async () => {
    seedGreenfield(fx);
    fx.write(
      "next.config.js",
      `/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\n\nmodule.exports = nextConfig;\n`,
    );
    await withCwd(fx.dir, () => init([]));

    const out = fx.read("next.config.js");
    expect(out).toContain(`const { withHoplens } = require("@hoplens/next")`);
    expect(out).toContain("module.exports = withHoplens(nextConfig)");
  });

  test("existing instrumentation with user register — injects block, keeps user code", async () => {
    seedGreenfield(fx);
    fx.write(
      "instrumentation.ts",
      `import { setupOtel } from "./lib/otel";\n\nexport async function register() {\n  await setupOtel();\n}\n`,
    );
    await withCwd(fx.dir, () => init([]));

    const out = fx.read("instrumentation.ts");
    expect(out).toContain("await setupOtel();");
    expect(out).toContain("@hoplens/next/node");
    expect(out).toContain(`NODE_ENV === "development"`);
  });

  test("idempotent — second run is a no-op", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => init([]));
    const configAfterFirst = fx.read("next.config.ts");
    const insAfterFirst = fx.read("instrumentation.ts");

    await withCwd(fx.dir, () => init([]));
    expect(fx.read("next.config.ts")).toBe(configAfterFirst);
    expect(fx.read("instrumentation.ts")).toBe(insAfterFirst);
  });

  test("--dry-run — does not write files", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => init(["--dry-run"]));
    expect(fx.exists("next.config.ts")).toBe(false);
    expect(fx.exists("instrumentation.ts")).toBe(false);
  });
});
