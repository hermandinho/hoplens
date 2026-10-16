const DEMOS: { href: string; finding: string; what: string }[] = [
  {
    href: "/api/feed",
    finding: "n-plus-1",
    what: "jsonplaceholder posts, then one author request per post. Compare with ?fast=1 (one batched users call).",
  },
  {
    href: "/api/dashboard",
    finding: "parallelizable",
    what: "Geocode a city, then weather (open-meteo), FX (frankfurter) and holidays (nager.date) awaited one by one. Compare with ?parallel=1.",
  },
  {
    href: "/api/catalog",
    finding: "duplicate, fetch-uncached",
    what: "dummyjson products; the category list is fetched twice and the FX quote uses cache: no-store.",
  },
  {
    href: "/api/pokemon/pikachu",
    finding: "fetch cache contrast",
    what: "pokeapi with next: { revalidate: 60 }. Compare with ?cache=0, which refetches ~300KB every time.",
  },
  {
    href: "/api/report",
    finding: "slow-fn, logs-on-success",
    what: "CPU-heavy crunchStats() plus a console.warn on success. Add ?big=1 for a >1MB response (large-payload).",
  },
  {
    href: "/api/flaky",
    finding: "swallowed-error",
    what: "Upstream fails ~50% of the time (503 or timeout); the error is caught and the route still returns 200. Force with ?mode=fail|timeout|ok.",
  },
  {
    href: "/api/db/products",
    finding: "n-plus-1 (SQL)",
    what: "In-process Postgres (PGlite + pg): a page of products, then one review-stats SELECT per row. Compare with ?fast=1 (one query, CTE + LATERAL join).",
  },
  {
    href: "/api/db/orders/42",
    finding: "duplicate (SQL)",
    what: "Loads the same order row twice (existence check, then the response) with identical SQL and params. Seeded ids are 1..300.",
  },
  {
    href: "/api/db/search?q=battery",
    finding: "slow query",
    what: "ILIKE %q% over 200k seeded reviews: a full table scan (~100ms+) on every request.",
  },
];

export default function Home() {
  return (
    <main style={{ padding: 40, fontFamily: "system-ui, sans-serif", lineHeight: 1.6, maxWidth: 900 }}>
      <h1>Hoplens example</h1>
      <p>
        Open <a href="/__hoplens">/__hoplens</a> to send requests to the API routes in <code>src/app/api</code> and
        watch their journey.
      </p>

      <h2>Demo routes</h2>
      <p>
        These call free public APIs (no keys) so Hoplens has realistic traffic to analyze; the <code>/api/db</code> ones
        query an in-process Postgres (PGlite, seeded on first use) instead. Each one triggers a specific finding. The
        first hit after starting <code>next dev</code> also shows <code>cold-compile</code>. Run{" "}
        <code>node scripts/traffic.mjs</code> to hit them all with their variants.
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th style={{ padding: "4px 8px" }}>Route</th>
            <th style={{ padding: "4px 8px" }}>Finding</th>
            <th style={{ padding: "4px 8px" }}>What it does</th>
          </tr>
        </thead>
        <tbody>
          {DEMOS.map((d) => (
            <tr key={d.href} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
              <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                <a href={d.href}>
                  <code>{d.href}</code>
                </a>
              </td>
              <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                <code>{d.finding}</code>
              </td>
              <td style={{ padding: "4px 8px" }}>{d.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
