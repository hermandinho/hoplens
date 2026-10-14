import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    next: "src/next.ts",
    trace: "src/trace.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  target: "node20",
  external: ["typescript", "next", "@hoplens/core", "@hoplens/next", "@hoplens/cli"],
});
