// Thin clients for free, no-auth public APIs. Every exported function here is wrapped by the
// Hoplens auto-tracer, so each call shows up as its own function hop around the outgoing fetch.
//
// The demo routes in src/app/api/{feed,dashboard,catalog,pokemon,report,flaky} compose these on
// purpose in good and bad ways, so every Hoplens finding has a route that triggers it.

const JSONPLACEHOLDER = "https://jsonplaceholder.typicode.com";
const DUMMYJSON = "https://dummyjson.com";
const OPEN_METEO = "https://api.open-meteo.com/v1";
const GEOCODING = "https://geocoding-api.open-meteo.com/v1";
const FRANKFURTER = "https://api.frankfurter.dev/v1";
const NAGER = "https://date.nager.at/api/v3";
const POKEAPI = "https://pokeapi.co/api/v2";
const HTTPBIN = "https://httpbin.org";

export class UpstreamError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${new URL(url).host} returned ${status}`);
    this.name = "UpstreamError";
  }
}

// Not exported: a shared helper would add one identical hop under every client call.
async function getJson<T>(url: string, init?: RequestInit & { next?: { revalidate?: number } }): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new UpstreamError(url, res.status);
  return (await res.json()) as T;
}

// --- jsonplaceholder: posts + authors (N+1 vs batched) ---------------------------------------

export type Post = { id: number; userId: number; title: string; body: string };
export type User = { id: number; name: string; username: string; email: string; company: { name: string } };

/** Latest posts, interleaved across authors (jsonplaceholder groups 10 posts per user). */
export async function listPosts(limit: number) {
  const posts = await getJson<Post[]>(`${JSONPLACEHOLDER}/posts`);
  return posts.sort((a, b) => ((a.id - 1) % 10) - ((b.id - 1) % 10) || a.id - b.id).slice(0, limit);
}

export async function getUser(id: number) {
  return getJson<User>(`${JSONPLACEHOLDER}/users/${id}`);
}

export async function getUsersByIds(ids: number[]) {
  const qs = ids.map((id) => `id=${id}`).join("&");
  return getJson<User[]>(`${JSONPLACEHOLDER}/users?${qs}`);
}

function toFeedItem(post: Post, author: User | undefined) {
  return {
    id: post.id,
    title: post.title,
    excerpt: `${post.body.slice(0, 80)}...`,
    author: author ? { id: author.id, name: author.name, company: author.company.name } : null,
  };
}

/** Deliberately N+1: one author request per post, awaited one after another. */
export async function buildFeedSlow(limit: number) {
  const posts = await listPosts(limit);
  const items = [];
  for (const post of posts) {
    const author = await getUser(post.userId);
    items.push(toFeedItem(post, author));
  }
  return items;
}

/** The fix: collect unique author ids and load them in one request. */
export async function buildFeedFast(limit: number) {
  const posts = await listPosts(limit);
  const ids = [...new Set(posts.map((p) => p.userId))];
  const users = await getUsersByIds(ids);
  const byId = new Map(users.map((u) => [u.id, u]));
  return posts.map((post) => toFeedItem(post, byId.get(post.userId)));
}

// --- open-meteo + frankfurter + nager.date: independent calls (sequential vs parallel) ---------

type GeoResult = {
  results?: {
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    country_code: string;
    timezone: string;
  }[];
};

export async function geocodeCity(city: string) {
  const data = await getJson<GeoResult>(`${GEOCODING}/search?name=${encodeURIComponent(city)}&count=1`);
  const hit = data.results?.[0];
  if (!hit) throw new Error(`No location found for "${city}"`);
  return hit;
}

export async function getWeather(lat: number, lon: number) {
  const data = await getJson<{ current: { temperature_2m: number; wind_speed_10m: number; weather_code: number } }>(
    `${OPEN_METEO}/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,weather_code`,
  );
  return { tempC: data.current.temperature_2m, windKmh: data.current.wind_speed_10m, code: data.current.weather_code };
}

export async function getFxRates(base: string, symbols: string[]) {
  const data = await getJson<{ date: string; rates: Record<string, number> }>(
    `${FRANKFURTER}/latest?from=${base}&to=${symbols.join(",")}`,
  );
  return { base, date: data.date, rates: data.rates };
}

export async function getUpcomingHolidays(countryCode: string) {
  const year = new Date().getFullYear();
  const all = await getJson<{ date: string; name: string; global: boolean }[]>(
    `${NAGER}/PublicHolidays/${year}/${countryCode}`,
  );
  const today = new Date().toISOString().slice(0, 10);
  return all.filter((h) => h.date >= today).slice(0, 3);
}

// --- dummyjson: catalog enrichment (duplicate + uncached fetches) ------------------------------

export type CatalogProduct = {
  id: number;
  title: string;
  price: number;
  rating: number;
  stock: number;
  brand?: string;
};

export async function listCategories() {
  // Same URL on every call and no cache option: called twice per /api/catalog request.
  return getJson<string[]>(`${DUMMYJSON}/products/category-list`);
}

export async function listCategoryProducts(category: string, limit: number) {
  const data = await getJson<{ products: CatalogProduct[]; total: number }>(
    `${DUMMYJSON}/products/category/${encodeURIComponent(category)}?limit=${limit}&select=title,price,rating,stock,brand`,
  );
  return data;
}

/** A live FX quote with `cache: "no-store"`: the same answer for hours, refetched on every request. */
export async function getLiveFxQuote(currency: string) {
  if (currency === "USD") return 1;
  const data = await getJson<{ rates: Record<string, number> }>(`${FRANKFURTER}/latest?from=USD&to=${currency}`, {
    cache: "no-store",
  });
  return data.rates[currency] ?? 1;
}

/** Re-loads the category list instead of reusing the one the caller already has (duplicate fetch). */
export async function buildFacets(products: CatalogProduct[]) {
  const categories = await listCategories();
  const brands = [...new Set(products.map((p) => p.brand).filter(Boolean))];
  return { categories: categories.length, brands };
}

export function convertPrices(products: CatalogProduct[], rate: number, currency: string) {
  return products.map((p) => ({ ...p, price: Math.round(p.price * rate * 100) / 100, currency }));
}

/** The first page of the whole catalog (100 products across all categories). */
export async function listAllProducts(limit: number) {
  return getJson<{ products: CatalogProduct[]; total: number }>(
    `${DUMMYJSON}/products?limit=${limit}&select=title,price,rating,stock,brand,category`,
  );
}

// --- pokeapi: Next fetch cache vs no-store -----------------------------------------------------

type PokemonRaw = {
  id: number;
  name: string;
  height: number;
  weight: number;
  base_experience: number;
  types: { type: { name: string } }[];
  abilities: { ability: { name: string } }[];
};

export async function getPokemon(name: string, cached: boolean) {
  const url = `${POKEAPI}/pokemon/${encodeURIComponent(name.toLowerCase())}`;
  const raw = await getJson<PokemonRaw>(url, cached ? { next: { revalidate: 60 } } : { cache: "no-store" });
  return {
    id: raw.id,
    name: raw.name,
    heightDm: raw.height,
    weightHg: raw.weight,
    baseExperience: raw.base_experience,
    types: raw.types.map((t) => t.type.name),
    abilities: raw.abilities.map((a) => a.ability.name),
  };
}

// --- flaky upstream: errors recorded on a span, then swallowed by the caller -------------------

export type FlakyMode = "ok" | "fail" | "timeout" | "random";

/** Throws on 503 or timeout. The route catches it and still answers 200 with a fallback. */
export async function fetchInventory(mode: FlakyMode) {
  const resolved = mode === "random" ? (Math.random() < 0.5 ? "fail" : "ok") : mode;
  if (resolved === "timeout") {
    // httpbin waits 3s; we give up after 800ms, so fetch rejects with a TimeoutError.
    await getJson(`${HTTPBIN}/delay/3`, { cache: "no-store", signal: AbortSignal.timeout(800) });
    return { source: "live" as const, items: [] };
  }
  const status = resolved === "fail" ? 503 : 200;
  await getJson(`${DUMMYJSON}/http/${status}`, { cache: "no-store" });
  return {
    source: "live" as const,
    items: [
      { sku: "hat-01", onHand: 14 },
      { sku: "bag-07", onHand: 3 },
    ],
  };
}
