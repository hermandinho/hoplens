import { defineConfig } from "tsup";

// CJS only: the ESM entry (esm/index.mjs) is a hand-written wrapper over dist/index.js, so `import`
// and `require` consumers share one module instance and one @hoplens/core. `register` must load
// under both `node -r` and `node --import`.
export default defineConfig({
  entry: { index: "src/index.ts", register: "src/register.ts" },
  format: ["cjs"],
  dts: { entry: { index: "src/index.ts", register: "src/register.ts" } },
  sourcemap: true,
  clean: true,
  target: "node20",
  external: ["@hoplens/core", "@hoplens/schema", "@hoplens/transform", "express"],
});
