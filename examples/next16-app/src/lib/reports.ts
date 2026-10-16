// CPU-bound work for /api/report. Exported so the auto-tracer gives each function its own hop:
// `crunchStats` is the slow one (slow-fn), `expandRows` makes the response big (large-payload).

import type { CatalogProduct } from "./external";

/** Burns CPU on purpose: naive trial-division primes plus repeated sorting, ~200ms at rounds=60. */
export function crunchStats(products: CatalogProduct[], rounds: number) {
  let primes = 0;
  for (let n = 2; n < rounds * 8_000; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) {
      if (n % d === 0) {
        prime = false;
        break;
      }
    }
    if (prime) primes++;
  }
  let sorted = products;
  for (let i = 0; i < rounds * 20; i++) {
    sorted = [...products].sort((a, b) => (i % 2 ? a.price - b.price : b.rating - a.rating));
  }
  const prices = products.map((p) => p.price);
  const total = prices.reduce((s, p) => s + p, 0);
  return {
    products: products.length,
    avgPrice: products.length ? Math.round((total / products.length) * 100) / 100 : 0,
    maxPrice: Math.max(0, ...prices),
    lowStock: products.filter((p) => p.stock < 10).map((p) => p.title),
    topRated: sorted.slice(0, 3).map((p) => p.title),
    primesChecked: primes,
  };
}

/** Repeats the rows until the JSON is well over 1MB. */
export function expandRows(products: CatalogProduct[], copies: number) {
  const rows = [];
  for (let c = 0; c < copies; c++) {
    for (const p of products) {
      rows.push({
        ...p,
        sku: `${p.id}-${c}`,
        warehouse: `WH-${(c % 12) + 1}`,
        note: "Synthetic row so the payload grows past the large-payload threshold.",
      });
    }
  }
  return rows;
}
