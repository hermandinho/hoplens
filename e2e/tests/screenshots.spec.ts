import { type APIResponse, type Page, expect, test } from "@playwright/test";

/**
 * One pass per viewport project (configured in playwright.config.ts): visit /__hoplens, snapshot
 * the empty Overview, send a real request through the live Next app, open it from the Requests
 * list and snapshot the trace, then drive a 500 error path and snapshot the failed trace.
 *
 * The UI is hash-routed (`#/requests`, `#/r/<id>`), so the tests navigate by URL instead of
 * clicking the view tabs: the desktop top bar and the phone bottom tabs (<= 760px) are different
 * elements, and the hash works the same on both.
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

/** Every traced dev response names its trace and carries Hoplens's Server-Timing entries. */
function traceIdOf(res: APIResponse): string {
  const headers = res.headers();
  expect(headers["server-timing"] ?? "").toContain("total;");
  const id = headers["x-hoplens-trace"];
  expect(id, "x-hoplens-trace header").toBeTruthy();
  return id as string;
}

/** Open the Requests list, wait for the trace's row to stream in over SSE, and open it. */
async function openFromRequests(page: Page, traceId: string): Promise<void> {
  await page.goto("/__hoplens#/requests");
  const row = page.locator(`[data-trace-id="${traceId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page).toHaveURL(new RegExp(`#/r/${traceId}`));
  // The journey canvas (Tree by default, the only mode on phones) has the `.waterfall` root.
  await expect(page.locator(".waterfall").first()).toBeVisible();
}

test.describe("Hoplens UI", () => {
  test("initial / empty state loads and matches snapshot", async ({ page, request }, info) => {
    // Clear traces from any earlier project run.
    await request.delete("/__hoplens/api/traces");

    await page.goto("/__hoplens");
    await expect(page.locator(".brand-name")).toHaveText("Hoplens");

    // The default view is the Overview; with no traffic it says so.
    await expect(page.getByText("No traffic yet")).toBeVisible({ timeout: 15_000 });

    // The Requests list has its own empty state.
    await page.goto("/__hoplens#/requests");
    await expect(page.getByText("No requests yet.")).toBeVisible();

    // Back to the Overview for the screenshot.
    await page.goto("/__hoplens#/");
    await expect(page.getByText("No traffic yet")).toBeVisible();

    await expect(page).toHaveScreenshot(`${info.project.name}-empty.png`, { fullPage: true });
  });

  test("after a real request, the trace opens beside the list and matches snapshot", async ({
    page,
    request,
  }, info) => {
    await request.delete("/__hoplens/api/traces");

    // Fire a valid POST through the live app so Hoplens captures a trace with all hop kinds.
    const res = await request.post("/api/orders", {
      headers: { "x-api-key": "dev-key", "content-type": "application/json" },
      data: VALID_ORDER,
    });
    expect(res.status()).toBe(201);

    await openFromRequests(page, traceIdOf(res));

    // Give the canvas and the details pane a tick to settle before snapshotting.
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

    await openFromRequests(page, traceIdOf(res));

    // The trace leads with a failing verdict sentence.
    await expect(page.locator("section.verdict.verdict-fail")).toBeVisible();

    // Canvas, verdict and details all need a tick to settle.
    await page.waitForTimeout(400);

    await expect(page).toHaveScreenshot(`${info.project.name}-with-error.png`, { fullPage: true });
  });
});
