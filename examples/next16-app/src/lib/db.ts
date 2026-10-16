import { Duplex } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

// A real Postgres for the DB demos, with no server and no docker: PGlite (Postgres compiled to WASM) runs
// in this process, and the stock `pg` client talks to it over an in-memory stream instead of a TCP socket.
// Because every query goes through the real `pg.Client.prototype.query`, Hoplens's pg hook sees it exactly
// like it would against a remote database: a `db` hop with the SQL, the bound params and the row count.
//
// Tables (seeded on first use, ~3s; the data is deterministic and lives in memory only):
//   categories(8) -> products(40) -> reviews(200k, indexed by product_id, full-text NOT indexed)
//   users(50) -> orders(300) -> order_items(~900)

/**
 * Minimal socket stand-in for `pg`: frames the frontend messages it writes and hands them to PGlite's
 * wire-protocol entrypoint, pushing back whatever the backend answers. Calls are chained so the
 * responses keep the order `pg` expects. `X` (Terminate) closes the stream instead of reaching PGlite.
 *
 * In-process calls have no network cost, which would make an N+1 look free. Each round trip (a simple
 * `Query` or an extended-protocol `Sync`) therefore waits `ROUND_TRIP_MS` first, like a database on the
 * same LAN (timer granularity can stretch it to ~15ms on Windows). `EXAMPLE_DB_LATENCY_MS=0` turns it off.
 */
const ROUND_TRIP_MS = Number(process.env.EXAMPLE_DB_LATENCY_MS ?? 2);
const QUERY = 0x51; // Q
const SYNC = 0x53; // S
const TERMINATE = 0x58; // X
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PGliteStream extends Duplex {
  private buf = Buffer.alloc(0);
  private started = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PGlite) {
    super();
  }

  // The parts of net.Socket that pg's Connection calls.
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  connect() {
    queueMicrotask(() => this.emit("connect"));
    return this;
  }

  override _read() {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (err?: Error | null) => void) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const messages: Buffer[] = [];
    let terminate = false;
    for (;;) {
      // The startup message has no type byte: Int32 length (self-inclusive), then the body.
      const header = this.started ? 5 : 4;
      if (this.buf.length < header) break;
      const len = this.started ? this.buf.readInt32BE(1) + 1 : this.buf.readInt32BE(0);
      if (this.buf.length < len) break;
      if (this.started && this.buf[0] === TERMINATE) terminate = true;
      else messages.push(this.buf.subarray(0, len));
      this.buf = this.buf.subarray(len);
      this.started = true;
    }
    if (messages.length > 0) {
      const data = new Uint8Array(Buffer.concat(messages));
      const roundTrip = ROUND_TRIP_MS > 0 && messages.some((m) => m[0] === QUERY || m[0] === SYNC);
      this.chain = this.chain
        .then(() => (roundTrip ? sleep(ROUND_TRIP_MS) : undefined))
        .then(() => this.db.execProtocolRaw(data))
        .then(
          (out) => {
            if (out.length > 0) this.push(Buffer.from(out));
          },
          (err) => this.destroy(err instanceof Error ? err : new Error(String(err))),
        );
    }
    if (terminate) this.chain = this.chain.then(() => this.push(null));
    done();
  }
}

const CATEGORIES = ["shoes", "bags", "hats", "jackets", "watches", "audio", "laptops", "phones"];
const WORDS = [
  "battery",
  "screen",
  "comfortable",
  "sturdy",
  "cheap",
  "broke",
  "gift",
  "shipping",
  "quality",
  "returned",
  "perfect",
  "noisy",
  "stylish",
  "heavy",
  "warranty",
  "recommend",
];
const sqlArray = (xs: string[]) => `array[${xs.map((x) => `'${x}'`).join(",")}]`;

// Everything is generated with generate_series so the seed is one round trip and identical on every boot.
const SEED = `
create table categories (id int primary key, name text not null);
insert into categories select g, (${sqlArray(CATEGORIES)})[g] from generate_series(1, ${CATEGORIES.length}) g;

create table products (
  id int primary key,
  name text not null,
  category_id int not null references categories(id),
  price_cents int not null,
  stock int not null
);
insert into products
  select g, initcap((${sqlArray(CATEGORIES)})[1 + g % ${CATEGORIES.length}]) || ' #' || g,
         1 + g % ${CATEGORIES.length}, 900 + (g * 7919) % 40000, (g * 31) % 120
  from generate_series(1, 40) g;

create table users (id int primary key, name text not null, email text not null);
insert into users select g, 'User ' || g, 'user' || g || '@example.test' from generate_series(1, 50) g;

create table orders (
  id int primary key,
  user_id int not null references users(id),
  status text not null,
  created_at timestamptz not null
);
insert into orders
  select g, 1 + (g * 13) % 50, (array['pending','paid','shipped','delivered'])[1 + g % 4],
         timestamptz '2026-01-01' + (g || ' hours')::interval
  from generate_series(1, 300) g;

create table order_items (
  order_id int not null references orders(id),
  product_id int not null references products(id),
  qty int not null,
  price_cents int not null
);
insert into order_items
  select o, 1 + (o * 7 + i * 11) % 40, 1 + (o + i) % 3, 900 + ((o * 7 + i * 11) % 40) * 250
  from generate_series(1, 300) o, generate_series(1, 3) i;

create table reviews (
  id int primary key,
  product_id int not null references products(id),
  user_id int not null references users(id),
  rating int not null,
  body text not null
);
insert into reviews
  select g, 1 + g % 40, 1 + g % 50, 1 + (g * 7) % 5,
         (${sqlArray(WORDS)})[1 + g % ${WORDS.length}] || ' ' ||
         (${sqlArray(WORDS)})[1 + (g * 7) % ${WORDS.length}] || ' ' ||
         (${sqlArray(WORDS)})[1 + (g * 13) % ${WORDS.length}] || ' ' || md5(g::text)
  from generate_series(1, 200000) g;
create index reviews_product_id on reviews (product_id);
analyze;
`;

type DbState = { client: Promise<pg.Client> };
const g = globalThis as typeof globalThis & { __exampleDb?: DbState };

/**
 * The shared connection. Survives dev reloads (kept on globalThis) and is created once; the seed runs on
 * PGlite directly, so it never shows up as queries in the first request's journey.
 */
function db(): Promise<pg.Client> {
  if (!g.__exampleDb) {
    const client = (async () => {
      const lite = await PGlite.create();
      await lite.exec(SEED);
      const c = new pg.Client({ stream: () => new PGliteStream(lite) });
      await c.connect();
      return c;
    })();
    g.__exampleDb = { client };
    // A failed boot shouldn't poison every later request.
    client.catch(() => {
      g.__exampleDb = undefined;
    });
  }
  return g.__exampleDb.client;
}

export type ProductRow = { id: number; name: string; category: string; price_cents: number; stock: number };
export type RatingRow = { reviews: number; rating: string | null };

/** One page of products with their category name. */
export async function listProducts(limit: number) {
  const c = await db();
  const { rows } = await c.query<ProductRow>(
    `select p.id, p.name, c.name as category, p.price_cents, p.stock
       from products p join categories c on c.id = p.category_id
      order by p.id limit $1`,
    [limit],
  );
  return rows;
}

/** Review stats for one product. Fine on its own; called once per row it is the N+1. */
export async function getProductRating(productId: number) {
  const c = await db();
  const { rows } = await c.query<RatingRow>(
    "select count(*)::int as reviews, round(avg(rating), 2)::text as rating from reviews where product_id = $1",
    [productId],
  );
  return rows[0] ?? { reviews: 0, rating: null };
}

/** The fixed version: products and their review stats in a single round trip (LATERAL join, index per row). */
export async function listProductsWithRatings(limit: number) {
  const c = await db();
  const { rows } = await c.query<ProductRow & RatingRow>(
    `with page as (
       select p.id, p.name, c.name as category, p.price_cents, p.stock
         from products p join categories c on c.id = p.category_id
        order by p.id limit $1
     )
     select page.*, s.reviews, s.rating
       from page cross join lateral (
         select count(*)::int as reviews, round(avg(rating), 2)::text as rating
           from reviews where product_id = page.id
       ) s
      order by page.id`,
    [limit],
  );
  return rows;
}

export type OrderRow = { id: number; status: string; created_at: string; user_id: number; user_name: string };
export type OrderItemRow = { product_id: number; name: string; qty: number; price_cents: number };

/** An order with its customer. */
export async function getOrder(id: number) {
  const c = await db();
  const { rows } = await c.query<OrderRow>(
    `select o.id, o.status, o.created_at, u.id as user_id, u.name as user_name
       from orders o join users u on u.id = o.user_id
      where o.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Line items of an order, with product names. */
export async function getOrderItems(orderId: number) {
  const c = await db();
  const { rows } = await c.query<OrderItemRow>(
    `select i.product_id, p.name, i.qty, i.price_cents
       from order_items i join products p on p.id = i.product_id
      where i.order_id = $1 order by p.name`,
    [orderId],
  );
  return rows;
}

export type ReviewHit = { id: number; product: string; rating: number; body: string };

/**
 * Substring search over 200k reviews. `ILIKE '%q%'` can't use an index, so the count is a full
 * sequential scan on every call (~100ms+): the slow query.
 */
export async function searchReviews(q: string, limit: number) {
  const c = await db();
  const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const total = await c.query<{ n: number }>("select count(*)::int as n from reviews where body ilike $1", [pattern]);
  const hits = await c.query<ReviewHit>(
    `select r.id, p.name as product, r.rating, r.body
       from reviews r join products p on p.id = r.product_id
      where r.body ilike $1 order by r.id limit $2`,
    [pattern, limit],
  );
  return { total: total.rows[0]?.n ?? 0, hits: hits.rows };
}
