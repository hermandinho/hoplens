import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * We start the Next.js example app via Playwright's webServer helper. The dev server launches
 * Hoplens via its instrumentation hook, so http://localhost:3100/__hoplens is served the moment
 * Next is ready. The three projects run the same specs at three viewport sizes so the snapshot
 * output pairs with the responsive breakpoints the UI advertises.
 */

const APP_PORT = 3100;
const BASE_URL = `http://localhost:${APP_PORT}`;
const APP_DIR = path.join(__dirname, "..", "examples", "next16-app");

export default defineConfig({
  testDir: "./tests",
  snapshotDir: "./snapshots",
  outputDir: "./test-results",
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      // Give the live-pill pulse / packet animation a little room to differ frame-to-frame.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    },
  },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `pnpm --filter example-next16-app exec next dev --port ${APP_PORT}`,
    cwd: APP_DIR,
    url: `${BASE_URL}/__hoplens/api/meta`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      PORT: String(APP_PORT),
      HOPLENS_PORT: "14983",
    },
  },
  projects: [
    {
      name: "desktop-1600",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "tablet-1100",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1100, height: 820 } },
    },
    {
      name: "mobile-420",
      use: { ...devices["Pixel 7"], viewport: { width: 420, height: 820 } },
    },
  ],
});
