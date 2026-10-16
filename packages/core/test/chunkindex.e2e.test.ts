// WP9c end-to-end: a real `next dev` (Turbopack) on a TEMP COPY of examples/next16-app, with the real
// source watcher, dist probe and chunk index from createEpochTracker running in this process.
//
// Opt-in (it starts Next and takes ~1-2 minutes): HOPLENS_E2E_NEXT=1 pnpm --filter @hoplens/core exec
// vitest run test/chunkindex.e2e.test.ts
//
// The copy lives next to the example (examples/wp9c-e2e-*) so Turbopack's workspace root resolves the
// example's pnpm node_modules through a junction; it is deleted afterwards. The real example, its .next
// and the dev server on :3000 are never touched.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { epochsService } from "../src/api/epochs";
import { type EpochTracker, createEpochTracker } from "../src/epoch";
import type { Runtime } from "../src/runtime";
import { RouteStatsStore } from "../src/stats";

const ENABLED = process.env.HOPLENS_E2E_NEXT === "1";
const EXAMPLE = path.resolve(__dirname, "../../../examples/next16-app");
const ORDER_ID = "9c1e7a52-4b0d-4e1a-9a55-1f3c2e8d0b77";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

/** Route templates of src/app/api/** route files, like the Next discovery source. */
function discoverRoutes(root: string) {
  const out: { nextRoute: string; file: string; methods: { method: string; line: number }[] }[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (/^route\.[jt]s$/.test(e.name))
        out.push({
          nextRoute: r.replace(/^src\/app/, "").replace(/\/route\.[jt]s$/, ""),
          file: r,
          methods: [{ method: "GET", line: 1 }],
        });
    }
  };
  walk("src/app/api");
  return out;
}

describe.skipIf(!ENABLED)("e2e: next dev on a temp copy of the example", () => {
  let root = "";
  let port = 0;
  let child: ChildProcess | undefined;
  let tracker: EpochTracker;
  let log = "";
  const seen = new Set<string>();

  const startNext = async () => {
    port = await freePort();
    log = "";
    child = spawn(
      process.execPath,
      [path.join(EXAMPLE, "node_modules/next/dist/bin/next"), "dev", "-p", String(port)],
      {
        cwd: root,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (d) => (log += String(d)));
    child.stderr?.on("data", (d) => (log += String(d)));
    const end = Date.now() + 90_000;
    while (!/Ready in|ready/i.test(log)) {
      if (Date.now() > end) throw new Error(`next dev did not start:\n${log}`);
      if (child.exitCode !== null) throw new Error(`next dev exited:\n${log}`);
      await wait(200);
    }
  };

  const stopNext = async () => {
    if (!child?.pid) return;
    const pid = child.pid;
    child = undefined;
    try {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await wait(1000);
  };

  /** One request, then the tracker's observe() the way capture's finalize calls it. */
  const hit = async (routeKey: string, url: string, init?: RequestInit) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, init);
    await res.arrayBuffer();
    // Let the bundler's trailing writes reach the watcher, as a later request would.
    await wait(1500);
    const compiled = !seen.has(routeKey);
    seen.add(routeKey);
    return { status: res.status, epoch: tracker.observe(routeKey, compiled).epoch };
  };

  const products = () => hit("GET /api/products", "/api/products?cat=hats&limit=2");
  const order = () => hit("GET /api/orders/[id]", `/api/orders/${ORDER_ID}`);
  const newsletter = () =>
    hit("POST /api/newsletter", "/api/newsletter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

  const storeFile = () => path.join(root, "src/lib/store.ts");

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(path.dirname(EXAMPLE), "wp9c-e2e-"));
    copyDir(path.join(EXAMPLE, "src"), path.join(root, "src"));
    fs.rmSync(path.join(root, "src/instrumentation.ts")); // no Hoplens inside the copy: this test is the observer
    for (const f of ["tsconfig.json", "package.json"]) fs.copyFileSync(path.join(EXAMPLE, f), path.join(root, f));
    fs.writeFileSync(
      path.join(root, "next.config.ts"),
      'export default { cacheComponents: true, serverExternalPackages: ["@electric-sql/pglite"] };\n',
    );
    fs.symlinkSync(path.join(EXAMPLE, "node_modules"), path.join(root, "node_modules"), "junction");
    tracker = createEpochTracker(root, ".next");
    await startNext();
  }, 120_000);

  afterAll(async () => {
    await stopNext();
    tracker?.close();
    if (root) {
      try {
        fs.unlinkSync(path.join(root, "node_modules")); // the junction only, never its target
      } catch {
        /* ignore */
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }, 60_000);

  test("store.ts edit: files [src/lib/store.ts], only the affected routes; formatter-only save: no epoch; rm -rf .next re-arms", async () => {
    // Compile three routes; two use the store, newsletter doesn't.
    expect((await products()).status).toBe(200);
    expect((await order()).status).toBe(200);
    expect((await newsletter()).status).toBe(422);
    // Past the settle window of the last compile, and let the chunk index finish its prime.
    await wait(2500);
    expect((await products()).epoch).toBe(0);

    // 1. Formatter-only save: different bytes (blank lines, re-indented, trailing commas), same code.
    const original = fs.readFileSync(storeFile(), "utf8");
    const formatted = original
      .replace(
        "export async function listProducts(cat: string, limit: number) {",
        "\n\nexport async function listProducts(\n  cat: string,\n  limit: number,\n) {",
      )
      .replace(/\n {2}await wait\(12\);/, "\n\n    await wait(12);");
    expect(formatted).not.toBe(original);
    const t0 = Date.now();
    fs.writeFileSync(storeFile(), formatted);
    await wait(1200);
    const fmt = await products();
    await order();
    expect(fmt.status).toBe(200);
    expect(tracker.epoch).toBe(0);
    expect(tracker.list()).toHaveLength(1);
    // Not vacuous: Next did rebuild (some server .js written after the save) -- or reports that it didn't.
    const rewrote = countWrittenSince(path.join(root, ".next/dev/server"), t0);
    console.log(`[wp9c e2e] formatter-only save: ${rewrote} server .js files rewritten, epoch ${tracker.epoch}`);

    // 2. A real edit to store.ts.
    fs.writeFileSync(storeFile(), formatted.replace("await wait(12);", "await wait(13);"));
    await wait(1200);
    const edit = await products();
    expect(edit.status).toBe(200);
    expect(edit.epoch).toBe(1);
    const info = tracker.info(1)!;
    console.log("[wp9c e2e] epoch 1", JSON.stringify(info));
    expect(info.files).toEqual(["src/lib/store.ts"]);
    expect(info.via).toBe("src-watch");
    expect(info.chunkScope?.routes.filter((r) => r.startsWith("/api/"))).toEqual(["/api/orders/[id]", "/api/products"]);

    // Through /api/epochs: compiled routes from the chunks, plus /api/orders (never compiled, imports
    // the store) from the import graph; newsletter and the rest are not affected.
    const rt = {
      root,
      options: {},
      epochs: tracker,
      stats: new RouteStatsStore(),
      store: { on() {}, off() {} },
      discover: () => ({ routes: discoverRoutes(root), typescript: true, scannedAt: 0 }),
    } as unknown as Runtime;
    const view = epochsService(rt).list().items[0]!;
    expect(view).toMatchObject({
      id: 1,
      files: ["src/lib/store.ts"],
      routes: ["/api/orders", "/api/orders/[id]", "/api/products"],
      routesVia: "chunks",
    });

    // 3. rm -rf .next (Next stopped, wiped, started again; the tracker lives on, as in a long session
    // whose output dir is wiped under it). The recompile of unchanged code is no epoch; the next edit is.
    await stopNext();
    fs.rmSync(path.join(root, ".next"), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    await startNext();
    await products();
    await order();
    await wait(4500); // re-arm retry (2s) + re-prime
    await products();
    expect(tracker.epoch).toBe(1);
    fs.writeFileSync(storeFile(), formatted.replace("await wait(12);", "await wait(14);"));
    await wait(1200);
    const again = await products();
    expect(again.epoch).toBe(2);
    expect(tracker.info(2)).toMatchObject({ files: ["src/lib/store.ts"], via: "src-watch" });
    expect(tracker.info(2)?.chunkScope?.routes.filter((r) => r.startsWith("/api/"))).toEqual([
      "/api/orders/[id]",
      "/api/products",
    ]);
  }, 300_000);
});

function countWrittenSince(dir: string, t: number): number {
  let n = 0;
  const walk = (d: string) => {
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && fs.statSync(p).mtimeMs >= t) n++;
    }
  };
  walk(dir);
  return n;
}
