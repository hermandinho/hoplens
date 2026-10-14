import type { Options } from "tsup";

export const base: Options = {
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  target: "node20",
  splitting: false,
  treeshake: false,
  external: ["typescript", "next", "@opentelemetry/api", "@opentelemetry/sdk-trace-base", "@opentelemetry/context-async-hooks"],
};
