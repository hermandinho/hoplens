import { expect, test } from "@playwright/test";

/**
 * One pass per viewport project (configured in playwright.config.ts): visit /__hoplens, snapshot
 * the empty state, send a real request through the live Next app, snapshot the loaded state, then
 * drive a 500 error path and snapshot the error-state trace.
 */

const VALID_ORDER = {
  productId: "3f2b8c1e-7a4d-4c2b-9e1f-5d6a7b8c9d0e",
  qty: 2,
  shipping: {
    method: "standard",
    address: { line1: "1200 Rue Sainte-Catherine", city: "Montreal", country: "CA" },
  },
};

// A pre-seeded order in the example app's in-memory store, already in "paid" status.
// PATCHing it a second time makes payOrder() throw, which turns into a 500 trace with
// a pinned error location — the exact path the Hoplens UI is designed to showcase.
const ALREADY_PAID_ORDER_ID = "9c1e7a52-4b0d-4e1a-9a55-1f3c2e8d0b77";

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
    // The default journey view (0.1.2+) is the waterfall; the old SVG flow view is behind the toggle.
    await expect(page.locator(".waterfall, .journey-canvas").first()).toBeVisible();

    // Give the SVG + response pane a tick to settle before snapshotting.
    await page.waitForTimeout(400);

    await expect(page).toHaveScreenshot(`${info.project.name}-with-trace.png`, { fullPage: true });
  });

  test("after a 500 handler throw, the trace renders in error state", async ({ page, request }, info) => {
    await request.delete("/__hoplens/api/traces");

    // Second PATCH on an already-paid order makes payOrder() throw a plain Error.
    // The example's proxy middleware gates non-GET /api/orders* on x-api-key.
    const res = await request.patch(`/api/orders/${ALREADY_PAID_ORDER_ID}`, {
      headers: { "x-api-key": "dev-key" },
    });
    expect(res.status()).toBe(500);

    await page.goto("/__hoplens");
    await page.getByRole("tab", { name: /^Traffic/ }).click();

    const firstTrace = page.locator(".trace-row").first();
    await expect(firstTrace).toBeVisible({ timeout: 15_000 });

    await firstTrace.click();
    // The default journey view (0.1.2+) is the waterfall; the old SVG flow view is behind the toggle.
    await expect(page.locator(".waterfall, .journey-canvas").first()).toBeVisible();

    // SVG + response + inspector all need a tick to settle.
    await page.waitForTimeout(400);

    await expect(page).toHaveScreenshot(`${info.project.name}-with-error.png`, { fullPage: true });
  });
});
