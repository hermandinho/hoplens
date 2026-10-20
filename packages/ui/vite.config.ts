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
        // changeOrigin rewrites Host to 127.0.0.1:4983 and the proxy connects from loopback, so on
        // its own core's guard (api/guard.ts) would see a local caller whatever the browser sent.
        // configure() passes the browser's real Host on as x-forwarded-host, which core checks
        // (DNS rebinding, a LAN Host under `vite --host`). It overwrites any client-sent value: a
        // rebound page can set that header, so `xfwd: true` (which keeps it) is not enough.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            proxyReq.setHeader("x-forwarded-host", req.headers.host ?? "");
          });
        },
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
