import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [preact(), viteSingleFile({ removeViteModuleLoader: true })],
  server: {
    port: 5173,
    // When running `pnpm --filter @hoplens/ui dev` alongside a Hoplens-instrumented app
    // (e.g. the example-next16-app), proxy API + SSE calls to the standalone loopback port.
    proxy: {
      "/__hoplens/api": {
        target: "http://127.0.0.1:4983",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
