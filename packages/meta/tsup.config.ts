import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    next: "src/next.ts",
    node: "src/node.ts",
    trace: "src/trace.ts",
  },
  format: ["cjs", "esm"],
  // Bundle types from the @hoplens/* workspace deps so `hoplens/next` is
  // self-contained — users don't need to install @hoplens/next directly for
  // TypeScript to resolve `import { withHoplens } from "hoplens/next"`.
  dts: { resolve: ["@hoplens/next", "@hoplens/core"] },
  sourcemap: true,
  clean: true,
  shims: true,
  target: "node20",
  // The hoplens tarball bundles the Next adapter + core runtime so a single
  // `npm i -D hoplens` is enough. Keeping the CLI external — users invoke it
  // via the bin shim which resolves @hoplens/cli at runtime.
  external: ["typescript", "next", "@hoplens/cli"],
});
