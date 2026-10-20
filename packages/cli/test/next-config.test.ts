import { loadTypeScript } from "@hoplens/transform/ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { doctor } from "../src/commands/doctor";
import { init } from "../src/commands/init";
import { remove } from "../src/commands/remove";
import { configState, guardConfig, unguardConfig } from "../src/next/wiring";
import { makeFixture, muteConsole, seedGreenfield, withCwd } from "./fixture";

const ts = loadTypeScript(process.cwd());

let fx: ReturnType<typeof makeFixture>;
let unmute: () => void;
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

const GATE_TS = [
  "export default async (phase: string, ctx: { defaultConfig: NextConfig }) => {",
  "  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;",
  "  // Hoplens is a dev dependency: only `next dev` loads it",
  '  const { withHoplens } = await import("hoplens/next" as string);',
  "  return withHoplens(nextConfig)(phase, ctx);",
  "};",
].join("\n");

/** Each config type init supports: the user's file, and what init writes from it. */
const GOLDEN: { name: string; before: string; after: string }[] = [
  {
    name: "next.config.ts",
    before: `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n`,
    after: `import type { NextConfig } from "next";\nimport { PHASE_DEVELOPMENT_SERVER } from "next/constants";\n\nconst nextConfig: NextConfig = { reactStrictMode: true };\n\n${GATE_TS}\n`,
  },
  {
    name: "next.config.mts",
    before: "const nextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n",
    after: [
      'import type { NextConfig } from "next";',
      'import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";',
      "",
      "const nextConfig = { reactStrictMode: true };",
      "",
      GATE_TS,
      "",
    ].join("\n"),
  },
  {
    name: "next.config.mjs",
    before: `/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n`,
    after: [
      'import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";',
      "",
      "/** @type {import('next').NextConfig} */",
      "const nextConfig = { reactStrictMode: true };",
      "",
      "export default async (phase, ctx) => {",
      "  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;",
      "  // Hoplens is a dev dependency: only `next dev` loads it",
      '  const { withHoplens } = await import("hoplens/next");',
      "  return withHoplens(nextConfig)(phase, ctx);",
      "};",
      "",
    ].join("\n"),
  },
  {
    name: "next.config.js",
    before: `/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\n\nmodule.exports = nextConfig;\n`,
    after: [
      'const { PHASE_DEVELOPMENT_SERVER } = require("next/constants");',
      "/** @type {import('next').NextConfig} */",
      "const nextConfig = { reactStrictMode: true };",
      "",
      "module.exports = async (phase, ctx) => {",
      "  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;",
      "  // Hoplens is a dev dependency: only `next dev` loads it",
      '  const { withHoplens } = require("hoplens/next");',
      "  return withHoplens(nextConfig)(phase, ctx);",
      "};",
      "",
    ].join("\n"),
  },
  {
    name: "next.config.cjs",
    before: "module.exports = { reactStrictMode: true }\n",
    after: [
      'const { PHASE_DEVELOPMENT_SERVER } = require("next/constants");',
      "module.exports = async (phase, ctx) => {",
      "  const config = { reactStrictMode: true };",
      "  if (phase !== PHASE_DEVELOPMENT_SERVER) return config;",
      "  // Hoplens is a dev dependency: only `next dev` loads it",
      '  const { withHoplens } = require("hoplens/next");',
      "  return withHoplens(config)(phase, ctx);",
      "}",
      "",
    ].join("\n"),
  },
  {
    // An ESM next.config.js (package "type": "module").
    name: "next.config.js",
    before: "export default { reactStrictMode: true };\n",
    after: [
      'import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";',
      "",
      "export default async (phase, ctx) => {",
      "  const config = { reactStrictMode: true };",
      "  if (phase !== PHASE_DEVELOPMENT_SERVER) return config;",
      "  // Hoplens is a dev dependency: only `next dev` loads it",
      '  const { withHoplens } = await import("hoplens/next");',
      "  return withHoplens(config)(phase, ctx);",
      "};",
      "",
    ].join("\n"),
  },
];

describe("next.config: init writes the dev-only form", () => {
  for (const g of GOLDEN) {
    test(`${g.name} (${g.before.split("\n").at(-2)}) — golden, idempotent, remove round trip`, async () => {
      seedGreenfield(fx);
      fx.write(g.name, g.before);
      await withCwd(fx.dir, () => init([]));
      expect(fx.read(g.name)).toBe(g.after);
      expect(configState(g.after)).toBe("guarded");

      await withCwd(fx.dir, () => init([]));
      expect(fx.read(g.name)).toBe(g.after);

      await withCwd(fx.dir, () => remove([]));
      expect(fx.read(g.name)).toBe(g.before);
    });
  }

  test("greenfield TS: creates the guarded next.config.ts, remove deletes it", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => init([]));
    expect(fx.read("next.config.ts")).toBe(
      `import type { NextConfig } from "next";\nimport { PHASE_DEVELOPMENT_SERVER } from "next/constants";\n\nconst nextConfig: NextConfig = {};\n\n${GATE_TS}\n`,
    );
    await withCwd(fx.dir, () => remove([]));
    expect(fx.exists("next.config.ts")).toBe(false);
  });

  test("greenfield JS: creates the guarded next.config.mjs", async () => {
    fx.write("package.json", JSON.stringify({ name: "fx", dependencies: { next: "^16.0.0" } }));
    await withCwd(fx.dir, () => init([]));
    const out = fx.read("next.config.mjs");
    expect(out.startsWith('import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";\n\n')).toBe(true);
    expect(out).toContain('await import("hoplens/next");');
    expect(configState(out)).toBe("guarded");
    await withCwd(fx.dir, () => remove([]));
    expect(fx.exists("next.config.mjs")).toBe(false);
  });

  test("a function config is called in production, and given to withHoplens in dev", () => {
    const src = `export default (phase) => ({ distDir: phase === "x" ? "a" : "b" });\n`;
    const r = guardConfig(ts, "next.config.mjs", src);
    if ("error" in r) throw new Error(r.error);
    // `phase` is used by the user's function, so the gate's parameter is renamed.
    expect(r.out).toContain("  const config = (phase) => ({");
    expect(r.out).toContain("  if (nextPhase !== PHASE_DEVELOPMENT_SERVER) return config(nextPhase, ctx);");
    expect(r.out).toContain("  return withHoplens(config)(nextPhase, ctx);");
    expect(unguardConfig(ts, "next.config.mjs", r.out)).toEqual({ out: src });
  });

  test("a function declared at the top level is called too; an existing constants import is reused", () => {
    const src = [
      'import { PHASE_DEVELOPMENT_SERVER } from "next/constants";',
      "",
      "function config(phase) {",
      "  return { reactStrictMode: phase === PHASE_DEVELOPMENT_SERVER };",
      "}",
      "",
      "module.exports = config;",
      "",
    ].join("\n");
    const r = guardConfig(ts, "next.config.ts", src.replace("module.exports =", "export default"));
    if ("error" in r) throw new Error(r.error);
    expect(r.out.match(/PHASE_DEVELOPMENT_SERVER } from/g)).toHaveLength(1);
    expect(r.out).toContain("return config(phase, ctx);");
    // The user's own import stays on remove: the restored config still uses it.
    expect(unguardConfig(ts, "next.config.ts", r.out)).toEqual({
      out: src.replace("module.exports =", "export default"),
    });
  });

  test("keeps CRLF line endings, and remove gives the CRLF file back", () => {
    const src = `import type { NextConfig } from "next";\r\n\r\nconst nextConfig: NextConfig = {};\r\n\r\nexport default nextConfig;\r\n`;
    const r = guardConfig(ts, "next.config.ts", src);
    if ("error" in r) throw new Error(r.error);
    expect(r.out.replace(/\r\n/g, "")).not.toContain("\n");
    // Same text as BASE_TS, so it reads as the greenfield config: remove would delete it.
    expect(unguardConfig(ts, "next.config.ts", r.out)).toEqual({ out: null });
    const user = src.replace("{}", "{ a: 1 }");
    const r2 = guardConfig(ts, "next.config.ts", user);
    if ("error" in r2) throw new Error(r2.error);
    expect(unguardConfig(ts, "next.config.ts", r2.out)).toEqual({ out: user });
  });

  test("an export init can't find is left alone with a warning", async () => {
    seedGreenfield(fx);
    const src = "const c = {};\nexport { c as default };\n";
    fx.write("next.config.mjs", src);
    await withCwd(fx.dir, () => init([]));
    expect(fx.read("next.config.mjs")).toBe(src);
  });
});

/** What init wrote before 0.3. */
const OLD_TS = `import type { NextConfig } from "next";\nimport { withHoplens } from "hoplens/next";\n\nconst nextConfig: NextConfig = { reactStrictMode: true };\n\nexport default withHoplens(nextConfig);\n`;
const ORIGINAL_TS = `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n`;

describe("next.config: the pre-0.3 top-level import", () => {
  test("init upgrades it to the golden form; remove then gives the original back", async () => {
    seedGreenfield(fx);
    fx.write("next.config.ts", OLD_TS);
    expect(configState(OLD_TS)).toBe("unguarded");
    await withCwd(fx.dir, () => init([]));
    expect(fx.read("next.config.ts")).toBe(GOLDEN[0]!.after);
    await withCwd(fx.dir, () => init([]));
    expect(fx.read("next.config.ts")).toBe(GOLDEN[0]!.after);
    await withCwd(fx.dir, () => remove([]));
    expect(fx.read("next.config.ts")).toBe(ORIGINAL_TS);
  });

  test("remove still undoes it directly", async () => {
    seedGreenfield(fx);
    fx.write("next.config.ts", OLD_TS);
    await withCwd(fx.dir, () => remove([]));
    expect(fx.read("next.config.ts")).toBe(ORIGINAL_TS);
  });

  test("upgrade keeps the options and the legacy @hoplens/next specifier", () => {
    const src = `const { withHoplens } = require("@hoplens/next");\nmodule.exports = withHoplens({ a: 1 }, { persist: true });\n`;
    const r = guardConfig(ts, "next.config.js", src);
    if ("error" in r) throw new Error(r.error);
    expect(r.upgraded).toBe(true);
    expect(r.out).toBe(
      [
        'const { PHASE_DEVELOPMENT_SERVER } = require("next/constants");',
        "module.exports = async (phase, ctx) => {",
        "  const config = { a: 1 };",
        "  if (phase !== PHASE_DEVELOPMENT_SERVER) return config;",
        "  // Hoplens is a dev dependency: only `next dev` loads it",
        '  const { withHoplens } = require("@hoplens/next");',
        "  return withHoplens(config, { persist: true })(phase, ctx);",
        "};",
        "",
      ].join("\n"),
    );
  });

  test("the pre-0.3 greenfield config becomes today's, which remove deletes", async () => {
    seedGreenfield(fx);
    fx.write("next.config.ts", `import { withHoplens } from "hoplens/next";\n\nexport default withHoplens({});\n`);
    await withCwd(fx.dir, () => init([]));
    expect(fx.read("next.config.ts")).toContain(GATE_TS);
    await withCwd(fx.dir, () => remove([]));
    expect(fx.exists("next.config.ts")).toBe(false);
  });

  test("an import init can't take over (more names than withHoplens) is left alone", async () => {
    seedGreenfield(fx);
    const src = `import { type HoplensOptions, withHoplens } from "hoplens/next";\n\nexport default withHoplens({}, {} as HoplensOptions);\n`;
    fx.write("next.config.ts", src);
    await withCwd(fx.dir, () => init([]));
    expect(fx.read("next.config.ts")).toBe(src);
  });
});

describe("instrumentation.ts", () => {
  test("init writes the import `as string` in .ts and a plain literal in .js", async () => {
    seedGreenfield(fx);
    await withCwd(fx.dir, () => init([]));
    expect(fx.read("instrumentation.ts")).toContain('    await import("hoplens/node" as string);\n');

    const js = makeFixture();
    try {
      js.write("package.json", JSON.stringify({ name: "fx", dependencies: { next: "^16.0.0" } }));
      await withCwd(js.dir, () => init([]));
      expect(js.read("instrumentation.js")).toContain('    await import("hoplens/node");\n');
    } finally {
      js.cleanup();
    }
  });

  test("init upgrades the pre-0.3 literal block in .ts; remove gives the user's file back", async () => {
    seedGreenfield(fx);
    const user = `import { setupOtel } from "./lib/otel";\r\n\r\nexport async function register() {\r\n  await setupOtel();\r\n}\r\n`;
    // What init wrote before 0.3: the literal block, with \n endings, before register()'s closing brace.
    const at = user.lastIndexOf("}");
    const block = [
      "  // Hoplens: request journey visualizer at /__hoplens (dev only)",
      '  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {',
      '    await import("hoplens/node");',
      "  }",
    ].join("\n");
    const old = `${user.slice(0, at)}\n${block}\n${user.slice(at)}`;
    fx.write("instrumentation.ts", old);
    await withCwd(fx.dir, () => init([]));
    expect(fx.read("instrumentation.ts")).toBe(old.replace('"hoplens/node"', '"hoplens/node" as string'));
    await withCwd(fx.dir, () => remove([]));
    expect(fx.read("instrumentation.ts")).toBe(user);
  });
});

describe("doctor on next.config", () => {
  async function run(files: Record<string, string>) {
    seedGreenfield(fx);
    fx.write("node_modules/next/package.json", JSON.stringify({ name: "next", version: "16.0.0" }));
    fx.write("node_modules/next/index.js", "module.exports = {};");
    fx.write("node_modules/hoplens/package.json", JSON.stringify({ name: "hoplens", version: "0.3.0" }));
    fx.write("node_modules/hoplens/index.js", "module.exports = {};");
    for (const [f, s] of Object.entries(files)) fx.write(f, s);
    const lines: string[] = [];
    unmute();
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      await withCwd(fx.dir, () => doctor([]));
    } finally {
      spy.mockRestore();
      unmute = muteConsole();
    }
    return lines.join("\n");
  }

  const ins = `export async function register() {\n  if (process.env.NODE_ENV === "development") {\n    await import("hoplens/node" as string);\n  }\n}\n`;

  test("the guarded form is fine", async () => {
    const out = await run({ "next.config.ts": GOLDEN[0]!.after, "instrumentation.ts": ins });
    expect(out).toContain("next.config.ts uses withHoplens, loaded by next dev only");
    expect(out).not.toContain("next build/start");
    expect(out).toContain("All set.");
    expect(process.exitCode).toBe(0);
  });

  test("the pre-0.3 form warns, without failing", async () => {
    const out = await run({ "next.config.ts": OLD_TS, "instrumentation.ts": ins });
    expect(out).toContain(
      "next.config.ts imports hoplens/next at the top: next build/start without dev dependencies will fail; run npx hoplens init to upgrade",
    );
    expect(process.exitCode).toBe(0);
  });

  test("a plain-literal hoplens/node import in instrumentation.ts warns", async () => {
    const out = await run({
      "next.config.ts": GOLDEN[0]!.after,
      "instrumentation.ts": ins.replace(' as string"', '"').replace('" as string', '"'),
    });
    expect(out).toContain("instrumentation.ts imports hoplens/node as a plain string");
    expect(process.exitCode).toBe(0);
  });
});
