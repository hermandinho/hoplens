import { signal } from "@preact/signals";

/*
 * Mobile (plan 3.6, WP11). At or below MOBILE_MAX_PX the shell switches to the phone layout: one
 * compact top row, bottom view tabs, a subject pushed over its list as a full-screen page, the tree
 * only (no flame), and the trace details in a bottom sheet. The CSS uses the same breakpoint
 * (`@media (max-width: 760px)`); this module is the script side of it plus the pure swipe logic.
 */

export const MOBILE_MAX_PX = 760;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_PX}px)`;

function query(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MOBILE_QUERY)
      : null;
  } catch {
    return null;
  }
}

const mql = query();

/** True while the viewport is phone-sized. Follows resizes and rotation. */
export const isMobile = signal<boolean>(mql?.matches ?? false);

mql?.addEventListener?.("change", (e) => {
  isMobile.value = e.matches;
});

/** The trace details bottom sheet (Request / Response / Console / Span) is open. Mobile only. */
export const detailsSheetOpen = signal(false);

export function openDetailsSheet(): void {
  detailsSheetOpen.value = true;
}

export function closeDetailsSheet(): void {
  detailsSheetOpen.value = false;
}

/* ------------------------------------------------------------------ swipe */

export interface SwipeGesture {
  /** End minus start, in CSS px (positive = rightwards / downwards). */
  dx: number;
  dy: number;
  /** Duration in ms. */
  dt: number;
}

/** Shorter than this is a tap or a wobble, not a swipe. */
export const SWIPE_MIN_PX = 64;
/** Slower than this is a drag (reading, selecting), not a flick. */
export const SWIPE_MAX_MS = 700;
/** The horizontal travel must beat the vertical one by this factor: a scroll is never a swipe. */
export const SWIPE_RATIO = 2;

/**
 * What a horizontal flick on the open request means, mirroring the subject bar's buttons:
 * swipe left ("next page") opens the older request, swipe right the newer one. null = not a swipe.
 */
export function swipeIntent(g: SwipeGesture): "older" | "newer" | null {
  if (!Number.isFinite(g.dx) || !Number.isFinite(g.dy) || !Number.isFinite(g.dt)) return null;
  if (g.dt < 0 || g.dt > SWIPE_MAX_MS) return null;
  const ax = Math.abs(g.dx);
  if (ax < SWIPE_MIN_PX || ax < Math.abs(g.dy) * SWIPE_RATIO) return null;
  return g.dx < 0 ? "older" : "newer";
}

/**
 * The neighbour of `id` in the list as shown (newest first): "newer" is the row above, "older" the
 * row below. undefined at either end or when `id` is not listed.
 */
export function neighbourId(
  rows: readonly { id: string }[],
  id: string | null | undefined,
  dir: "older" | "newer",
): string | undefined {
  if (!id) return undefined;
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return undefined;
  return rows[dir === "newer" ? i - 1 : i + 1]?.id;
}
