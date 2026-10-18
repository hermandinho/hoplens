import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      loader: "src/loader.ts",
      register: "src/register.ts",
      ts: "src/ts.ts",
    },
    format: ["cjs"],
    dts: { entry: { index: "src/index.ts", register: "src/register.ts", ts: "src/ts.ts" } },
    sourcemap: true,
    // The ESM hook below is built by the second config, in parallel: never clean its output here.
    clean: ["!hooks.mjs", "!hooks.mjs.map"],
    shims: true,
    target: "node20",
    external: ["typescript"],
  },
  {
    // The ESM load hook `module.register()` loads (register.ts). It requires dist/index.js at runtime.
    entry: { hooks: "src/hooks.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    sourcemap: true,
    clean: false,
    target: "node20",
    external: ["typescript", "./index.js"],
  },
]);
