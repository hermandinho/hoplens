import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node.ts" },
  format: ["cjs", "esm"],
  dts: { entry: { index: "src/index.ts", node: "src/node.ts" } },
  sourcemap: true,
  clean: true,
  shims: true,
  target: "node20",
  external: [
    "typescript",
    "next",
    "@hoplens/core",
    "@hoplens/schema",
    "@hoplens/transform",
    "@hoplens/transform/ts",
    "@hoplens/transform/loader",
  ],
});
