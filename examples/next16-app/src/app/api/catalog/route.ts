import { buildFacets, convertPrices, getLiveFxQuote, listCategories, listCategoryProducts } from "@/lib/external";
import { CatalogQuery } from "@/lib/schemas";
import { type NextRequest, NextResponse } from "next/server";

// Duplicate + uncached fetches: the category list is loaded twice per request (here and again in
// buildFacets), and the FX quote is fetched with cache: "no-store" every time.
// Hoplens also reports an info-level "parallelizable" chain here. The rule can't see data
// dependencies: listCategoryProducts and buildFacets do depend on what ran before them, so only
// getLiveFxQuote could really move into a Promise.all with listCategoryProducts.
export async function GET(req: NextRequest) {
  const parsed = CatalogQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  const { category, limit, currency } = parsed.data;

  const categories = await listCategories();
  if (!categories.includes(category)) {
    return NextResponse.json({ error: `Unknown category "${category}"`, categories }, { status: 404 });
  }
  const { products, total } = await listCategoryProducts(category, limit);
  const rate = await getLiveFxQuote(currency);
  const facets = await buildFacets(products);

  return NextResponse.json({
    category,
    total,
    currency,
    rate,
    facets,
    items: convertPrices(products, rate, currency),
  });
}
