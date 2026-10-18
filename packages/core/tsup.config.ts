import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    trace: "src/trace.ts",
    // Pure, dependency-free search grammar the UI can bundle.
    query: "src/query.ts",
    // Request path: block coverage started by the Express register hook before any app module loads.
    // Its own tiny entry so the hook loads nothing else of core that early (HOPLENS_PATH=1 only).
    coverage: "src/path/coverage.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  target: "node20",
  splitting: false,
  external: [
    "typescript",
    "next",
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/context-async-hooks",
    "@hoplens/ui",
  ],
});
