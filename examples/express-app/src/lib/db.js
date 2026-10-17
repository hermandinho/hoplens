import { Duplex } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

// A real Postgres with no server and no docker: PGlite (Postgres compiled to WASM) runs in this process,
// and a stock `pg.Pool` talks to it over an in-memory stream instead of a TCP socket. Every query goes
// through the real `pg.Client.prototype.query`, so Hoplens records it as a `db` hop with the SQL, the
// bound params and the row count, exactly as it would against a remote database.
// (Adapted from examples/next16-app/src/lib/db.ts, with a smaller seed.)
//
// Tables (seeded at boot, well under a second; deterministic, in memory only):
//   users(20) -> orders(100, user_id = 1 + (id * 7) % 20) -> order_items(6 per order) -> products(30)

/**
 * In-process calls have no network cost, which would make an N+1 look free. Each round trip (a simple
 * `Query` or an extended-protocol `Sync`) therefore waits `ROUND_TRIP_MS` first, like a database on the
 * same LAN (timer granularity can stretch it to ~15ms on Windows). `EXAMPLE_DB_LATENCY_MS=0` turns it off.
 */
const ROUND_TRIP_MS = Number(process.env.EXAMPLE_DB_LATENCY_MS ?? 2);
const QUERY = 0x51; // Q
const SYNC = 0x53; // S
const TERMINATE = 0x58; // X
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal socket stand-in for `pg`: frames the frontend messages it writes and hands them to PGlite's
 * wire-protocol entrypoint, pushing back whatever the backend answers. Calls are chained so responses
 * keep the order `pg` expects. `X` (Terminate) closes the stream instead of reaching PGlite.
 */
class PGliteStream extends Duplex {
  /** @param {Promise<PGlite>} lite */
  constructor(lite) {
    super();
    this.buf = Buffer.alloc(0);
    this.started = false;
    this.chain = lite;
    this.lite = lite;
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

  _read() {}

  _write(chunk, _encoding, done) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const messages = [];
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
        .then(() => this.lite)
        .then((db) => db.execProtocolRaw(data))
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

const CATEGORIES = ["shoes", "bags", "hats", "jackets", "watches", "audio"];
const sqlArray = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]`;

// generate_series keeps the seed to one round trip and identical on every boot.
const SEED = `
create table users (id int primary key, name text not null, email text not null);
insert into users select g, 'User ' || g, 'user' || g || '@example.test' from generate_series(1, 20) g;

create table products (
  id int primary key,
  name text not null,
  category text not null,
  price_cents int not null,
  stock int not null
);
insert into products
  select g, initcap((${sqlArray(CATEGORIES)})[1 + g % ${CATEGORIES.length}]) || ' #' || g,
         (${sqlArray(CATEGORIES)})[1 + g % ${CATEGORIES.length}], 900 + (g * 7919) % 40000, (g * 31) % 120
  from generate_series(1, 30) g;

create table orders (
  id serial primary key,
  user_id int not null references users(id),
  status text not null,
  created_at timestamptz not null default now()
);
insert into orders (id, user_id, status, created_at)
  select g, 1 + (g * 7) % 20, (array['pending','paid','shipped','delivered'])[1 + g % 4],
         timestamptz '2026-01-01' + (g || ' hours')::interval
  from generate_series(1, 100) g;
select setval('orders_id_seq', 100);

create table order_items (
  order_id int not null references orders(id),
  product_id int not null references products(id),
  qty int not null,
  price_cents int not null
);
insert into order_items
  select o, 1 + (o * 7 + i * 11) % 30, 1 + (o + i) % 3, 900 + ((o * 7 + i * 11) % 30) * 250
  from generate_series(1, 100) o, generate_series(1, 6) i;
analyze;
`;

/** PGlite booted and seeded. The seed runs on PGlite directly, so it never shows up as a query. */
export const ready = PGlite.create().then(async (lite) => {
  await lite.exec(SEED);
  return lite;
});

/**
 * A stock pg Pool over the in-process database. PGlite is a single Postgres session, so the pool holds
 * one connection that never idles out (`Promise.all` over this pool still queues; that's fine here).
 */
export const pool = new pg.Pool({
  max: 1,
  idleTimeoutMillis: 0,
  stream: () => new PGliteStream(ready),
});
