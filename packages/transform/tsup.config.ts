import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    loader: "src/loader.ts",
    register: "src/register.ts",
    ts: "src/ts.ts",
  },
  format: ["cjs"],
  dts: { entry: { index: "src/index.ts", register: "src/register.ts", ts: "src/ts.ts" } },
  sourcemap: true,
  clean: true,
  shims: true,
  target: "node20",
  external: ["typescript"],
});
