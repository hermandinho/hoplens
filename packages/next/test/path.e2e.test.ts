// Request path P6 end to end: a COPY of examples/next16-app under a real `next dev`, once with
// Turbopack and once with --webpack, with HOPLENS_PATH=1. Trace path replays GET /api/products with
// its two inputs (no query: the 200 arm; ?limit=abc: the 422 arm) and the payload's arms must be
// exactly those, mapped through the bundler's source maps (Turbopack sidecar chunk maps, webpack
// eval-source-map modules).
//
// Opt-in (it starts Next twice, ~1-3 minutes): HOPLENS_E2E_NEXT=1 pnpm --filter @hoplens/next exec
// vitest run test/path.e2e.test.ts
//
// The copy lives in HOPLENS_E2E_DIR (default: a `hoplens-e2e` dir next to the repo). It must be on the
// repo's drive: Turbopack panics on a junction to another drive. Its node_modules are junctions, one
// per package, to the example's own targets (the workspace packages for @hoplens/*), and its .next
// and state dir are its own. The example, its .next and any dev server running it are never touched.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ENABLED = process.env.HOPLENS_E2E_NEXT === "1";
const REPO = path.resolve(__dirname, "../../..");
const EXAMPLE = path.join(REPO, "examples/next16-app");
const BASE = path.resolve(process.env.HOPLENS_E2E_DIR ?? path.join(REPO, "..", "hoplens-e2e"));

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

/** The deepest directory holding both paths. */
function commonDir(a: string, b: string): string {
  const x = path.resolve(a).split(path.sep);
  const y = path.resolve(b).split(path.sep);
  const out: string[] = [];
  for (let i = 0; i < Math.min(x.length, y.length) && x[i]!.toLowerCase() === y[i]!.toLowerCase(); i++) out.push(x[i]!);
  return out.join(path.sep) || path.sep;
}

/** node_modules of the copy: one junction per package, to what the example's entry resolves to. */
function linkModules(root: string): void {
  const nm = path.join(root, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  const link = (name: string, target: string) => {
    const at = path.join(nm, name);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    if (!fs.existsSync(at)) fs.symlinkSync(target, at, "junction");
  };
  const src = path.join(EXAMPLE, "node_modules");
  for (const e of fs.readdirSync(src)) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) {
      for (const s of fs.readdirSync(path.join(src, e))) link(`${e}/${s}`, fs.realpathSync(path.join(src, e, s)));
    } else link(e, fs.realpathSync(path.join(src, e)));
  }
  // Turbopack resolves the loader (and core, bundled into instrumentation) from the app itself.
  for (const p of ["core", "next", "schema", "transform", "ui"]) link(`@hoplens/${p}`, path.join(REPO, "packages", p));
}

function request(port: number, method: string, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, timeout: 300_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function json(port: number, method: string, p: string): Promise<any> {
  const r = await request(port, method, p);
  try {
    return JSON.parse(r.body);
  } catch {
    throw new Error(`${method} ${p}: ${r.status} ${r.body.slice(0, 300)}`);
  }
}

/** `label: then=n else=n` of a function's decisions. */
const arms = (fn: any): string[] =>
  (fn?.analysis?.decisions ?? []).map(
    (d: any) =>
      `${d.label}: ${d.arms.map((a: any) => `${a.label}=${a.taken === "unknown" ? `?${a.why}` : a.count}`).join(" ")}`,
  );

describe.skipIf(!ENABLED).each([
  ["turbopack", [] as string[]],
  ["webpack", ["--webpack"]],
] as const)("e2e: Trace path under next dev (%s)", (bundler, flags) => {
  let root = "";
  let appPort = 0;
  let uiPort = 0;
  let child: ChildProcess | undefined;
  let log = "";

  beforeAll(async () => {
    fs.mkdirSync(BASE, { recursive: true });
    root = fs.mkdtempSync(path.join(BASE, `next-path-${bundler}-`));
    copyDir(path.join(EXAMPLE, "src"), path.join(root, "src"));
    for (const f of ["tsconfig.json", "package.json", "next-env.d.ts"])
      if (fs.existsSync(path.join(EXAMPLE, f))) fs.copyFileSync(path.join(EXAMPLE, f), path.join(root, f));
    linkModules(root);
    const tpRoot = commonDir(root, REPO);
    appPort = await freePort();
    uiPort = await freePort();
    const stateDir = path.join(root, "hoplens-state");
    fs.writeFileSync(
      path.join(root, "next.config.ts"),
      `import { withHoplens } from "@hoplens/next";
export default withHoplens(
  {
    cacheComponents: true,
    partialPrefetching: true,
    serverExternalPackages: ["@electric-sql/pglite"],
    turbopack: { root: ${JSON.stringify(tpRoot)} },
    outputFileTracingRoot: ${JSON.stringify(tpRoot)},
  },
  { port: ${uiPort}, stateDir: ${JSON.stringify(stateDir)} },
);
`,
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      HOPLENS_PATH: "1",
      HOPLENS_PORT: String(uiPort),
      PORT: String(appPort),
    };
    for (const k of [
      "NODE_OPTIONS",
      "NODE_V8_COVERAGE",
      "HOPLENS_OPTIONS",
      "HOPLENS_PATH_DEBUGGER",
      "VITEST",
      "NODE_ENV",
    ])
      delete env[k];
    child = spawn(
      process.execPath,
      [path.join(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(appPort), ...flags],
      {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    child.stdout?.on("data", (d) => (log += String(d)));
    child.stderr?.on("data", (d) => (log += String(d)));
    const end = Date.now() + 120_000;
    while (!/Ready in/i.test(log)) {
      if (Date.now() > end) throw new Error(`next dev did not start:\n${log}`);
      if (child.exitCode !== null) throw new Error(`next dev exited:\n${log}`);
      await wait(200);
    }
    // The first request loads instrumentation (Next 16 loads it lazily) and so Hoplens: untraced.
    const first = await request(appPort, "GET", "/api/products");
    expect(first.status, log).toBe(200);
  }, 400_000);

  afterAll(async () => {
    const pid = child?.pid;
    if (pid) {
      try {
        if (process.platform === "win32")
          execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await wait(1500);
    }
    if (root) {
      // Junctions first (never their targets), then the copy.
      const nm = path.join(root, "node_modules");
      const unlink = (dir: string) => {
        for (const e of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
          const p = path.join(dir, e);
          if (e.startsWith("@") && !fs.lstatSync(p).isSymbolicLink()) unlink(p);
          else
            try {
              fs.unlinkSync(p);
            } catch {
              /* not a link */
            }
        }
      };
      unlink(nm);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }, 60_000);

  /** Request `p`, find its trace, Trace path it: the payload. */
  async function tracePath(p: string, status: number): Promise<any> {
    const r = await request(appPort, "GET", p);
    expect(r.status).toBe(status);
    let id: string | undefined;
    for (let i = 0; i < 50 && !id; i++) {
      const list = await json(uiPort, "GET", "/__hoplens/api/traces");
      id = list.find((t: any) => t.done && !t.pathTrace && t.url === p && t.status === status)?.id;
      if (!id) await wait(200);
    }
    expect(id, `no trace for ${p}`).toBeDefined();
    const out = await json(uiPort, "POST", `/__hoplens/api/traces/${id}/path`);
    expect(out.error, JSON.stringify(out)).toBeUndefined();
    return out.path;
  }

  test("meta says the request path is on (HOPLENS_PATH) for next", async () => {
    const meta = await json(uiPort, "GET", "/__hoplens/api/meta");
    expect(meta.framework?.name).toBe("next");
    expect(meta.path).toMatchObject({ state: "on", source: "env" });
  });

  test("GET /api/products: the 200 arm, through the bundler's maps", async () => {
    const p = await tracePath("/api/products", 200);
    const get = Object.values<any>(p.functions).find((f) => f.file === "src/app/api/products/route.ts");
    const list = Object.values<any>(p.functions).find((f) => f.name === "listProducts");
    console.log(`[p6 e2e ${bundler}] window`, JSON.stringify(p.window));
    expect(p.quality, JSON.stringify(p.warnings)).toBe("exact");
    expect(get.mapping).toBe("sourcemap");
    expect(get.generated.via).toBe("bundle");
    expect(get.truth).toEqual({ t: "taken", n: 1 });
    expect(arms(get)).toEqual(["!parsed.success: then=0 else=1"]);
    expect(list.truth).toEqual({ t: "taken", n: 1 });
    expect(p.analysis.text).toMatch(/^Exited: return at .* L11$/);
    // The filter kept a handful of the hundreds of scripts V8 reported, and says what it dropped.
    expect(p.window.scripts).toBeLessThan(p.window.totalScripts / 5);
    expect(p.window.bundled.kinds[bundler === "webpack" ? "webpack" : "chunk"]).toBeGreaterThan(0);
    expect(p.window.takeMs).toHaveLength(2);
  }, 120_000);

  test("GET /api/products?limit=abc: the 422 arm", async () => {
    const p = await tracePath("/api/products?limit=abc", 422);
    const get = Object.values<any>(p.functions).find((f) => f.file === "src/app/api/products/route.ts");
    expect(p.quality, JSON.stringify(p.warnings)).toBe("exact");
    expect(arms(get)).toEqual(["!parsed.success: then=1 else=0"]);
    expect(Object.values<any>(p.functions).some((f) => f.name === "listProducts")).toBe(false);
    expect(p.analysis.text).toMatch(/L8 via if !parsed\.success -> then$/);
  }, 120_000);
});
