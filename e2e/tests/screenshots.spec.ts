import { expect, test } from "@playwright/test";

/**
 * One pass per viewport project (configured in playwright.config.ts): visit /__hoplens, snapshot
 * the empty state, send a real request through the live Next app, snapshot the loaded state.
 */

const VALID_ORDER = {
  productId: "3f2b8c1e-7a4d-4c2b-9e1f-5d6a7b8c9d0e",
  qty: 2,
  shipping: {
    method: "standard",
    address: { line1: "1200 Rue Sainte-Catherine", city: "Montreal", country: "CA" },
  },
};

test.describe("Hoplens UI", () => {
  test("initial / empty state loads and matches snapshot", async ({ page, request }, info) => {
    // Clear traces from any earlier project run.
    await request.delete("/__hoplens/api/traces");

    await page.goto("/__hoplens");
    await expect(page.locator(".brand-name")).toHaveText("Hoplens");

    // Sidebar routes list populated via the live /api/routes endpoint.
    await expect(page.locator(".route-row").first()).toBeVisible({ timeout: 15_000 });

    // Empty traffic state in the sidebar.
    await page.getByRole("tab", { name: /^Traffic/ }).click();
    await expect(page.getByText("No requests yet.")).toBeVisible();

    // Back to Routes for the screenshot.
    await page.getByRole("tab", { name: /^Routes$/ }).click();
    await expect(page.locator(".route-row").first()).toBeVisible();

    await expect(page).toHaveScreenshot(`${info.project.name}-empty.png`, { fullPage: true });
  });

  test("after a real request, journey + details populate and match snapshot", async ({ page, request }, info) => {
    await request.delete("/__hoplens/api/traces");

    // Fire a valid POST through the live app so Hoplens captures a trace with all hop kinds.
    const res = await request.post("/api/orders", {
      headers: { "x-api-key": "dev-key", "content-type": "application/json" },
      data: VALID_ORDER,
    });
    expect(res.status()).toBe(201);

    await page.goto("/__hoplens");
    await page.getByRole("tab", { name: /^Traffic/ }).click();

    // Wait for the live SSE to deliver the trace into the sidebar.
    const firstTrace = page.locator(".trace-row").first();
    await expect(firstTrace).toBeVisible({ timeout: 15_000 });

    // Click into the trace to drive the journey + details panes.
    await firstTrace.click();
    await expect(page.locator(".journey-canvas")).toBeVisible();

    // Give the SVG + response pane a tick to settle before snapshotting.
    await page.waitForTimeout(400);

    await expect(page).toHaveScreenshot(`${info.project.name}-with-trace.png`, { fullPage: true });
  });
});
