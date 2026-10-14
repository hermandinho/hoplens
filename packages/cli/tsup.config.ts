import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  shims: true,
  target: "node20",
  external: ["typescript", "@hoplens/transform"],
  banner: { js: "#!/usr/bin/env node" },
});
