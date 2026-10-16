/*
 * Roving focus for a small popup menu (role="menu"): which item a key moves to. Pure, so the copy
 * menu (`y`) and any later menu share one tested rule. ARIA menu pattern: arrows wrap, Home/End jump.
 */

/** The item index `key` moves focus to, or null when the key is not a menu navigation key. */
export function menuStep(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  const cur = current >= 0 && current < count ? current : -1;
  switch (key) {
    case "ArrowDown":
      return cur < 0 ? 0 : (cur + 1) % count;
    case "ArrowUp":
      return cur < 0 ? count - 1 : (cur - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
