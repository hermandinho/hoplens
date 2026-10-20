// Request path P5 end to end: a TypeScript Express 5 app in child processes, under every runner the
// adapter supports, with real coverage. ORACLE: Node's own type stripping (types become spaces, so
// V8's offsets are the file's: P2's identity analysis) is the ground truth; tsx's output (offsets
// shifted, one minified line per module) must give the same analysis of every function, through its
// source map (mapping 'sourcemap'). Where the text V8 ran is not at hand (tsx registered after
// Hoplens), every function is UNKNOWN 'no-generated-text' unless the opt-in Debugger read is on; a
// function the compiler changed (a dropped statement) is UNKNOWN 'unmapped'; nothing is guessed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Child, type Fixture, REGISTER, childEnv, freePort, makeFixture, poll, run } from "./helpers";
import { testNodeFeatures } from "./test-node";

const REGISTER_URL = pathToFileURL(REGISTER).href;
const REPO = path.resolve(__dirname, "..", "..", "..");
const TSX_DIR = path.dirname(require.resolve("tsx/package.json", { paths: [REPO] }));
const TSX_CLI = path.join(TSX_DIR, "dist", "cli.mjs");
const TSX_LOADER = pathToFileURL(path.join(TSX_DIR, "dist", "loader.mjs")).href;

const BRANCHY = `// Branchy TypeScript: types everywhere, so compiled offsets really shift.
export interface Item {
  id: number;
  kind: "a" | "b" | "c" | "d";
}

type Opts<T> = { pick?: (x: T) => boolean; limit: number };

let ticks = 0;
function tick(): void {
  ticks++;
}

function boom(msg: string): never {
  throw new Error(msg);
}

export function classify(item: Item, high: boolean): string {
  let out: string = "";
  if (item.id < 0) {
    return "negative";
  } else if (item.id === 0) {
    out = "zero";
  } else {
    out = high ? "high" : "low";
  }
  switch (item.kind) {
    case "a":
      out += ":a";
    case "b":
      out += ":ab";
      break;
    case "c": {
      out += ":c";
      break;
    }
    default:
      out += ":?";
  }
  return out;
}

export function scan<T extends { id: number }>(rows: readonly T[], opts: Opts<T>): number {
  let n: number = 0;
  for (const r of rows) {
    if (opts.pick && !opts.pick(r)) continue;
    if (n >= opts.limit) return -1;
    n += r.id as number;
  }
  let i = 0;
  while (i < 3) {
    i++;
  }
  return n + ticks * 0;
}

export function guarded(flag: boolean): string {
  try {
    if (flag) boom("bad");
    return "ok";
  } catch (err: unknown) {
    const e = err as Error;
    return e.message ?? "unknown";
  } finally {
    tick();
  }
}

export function dropped(flag: boolean): number {
  void 0;
  if (flag) {
    return 1;
  }
  return 0;
}
`;

const ROUTES = `import { type Request, type Response, Router } from "express";
import { classify, dropped, guarded, type Item, scan } from "./branchy.ts";

export const api = Router();

const ITEMS: Item[] = [
  { id: 1, kind: "a" },
  { id: 0, kind: "c" },
  { id: -1, kind: "b" },
  { id: 5, kind: "d" },
];

api.get("/run/:mode", (req: Request, res: Response) => {
  const mode: string = String(req.params.mode);
  const out: string[] = [];
  if (mode === "all") {
    for (const it of ITEMS) out.push(classify(it, it.id > 2));
  } else {
    out.push(classify(ITEMS[0]!, false));
  }
  const total = scan(ITEMS, { limit: 10, pick: (x) => x.id >= 0 });
  res.json({ out, total, g: [guarded(mode === "all"), guarded(false)], d: dropped(mode === "all") });
});
`;

const SERVER = `import express from "express";
import { api } from "./routes.ts";

const app = express();
app.use("/api", api);
const server = app.listen(0, "127.0.0.1", () => {
  const a = server.address() as { port: number };
  console.log(JSON.stringify({ ready: a.port }));
});
`;

interface Res {
  status: number;
  body: string;
}

function request(port: number, method: string, p: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
const json = async (port: number, method: string, p: string) => {
  const r = await request(port, method, p);
  return { status: r.status, body: JSON.parse(r.body) };
};

/** Kill the child and everything it started (node --watch / tsx watch run the app in a grandchild). */
function killTree(c: Child): Promise<void> {
  const pid = c.proc.pid;
  if (process.platform === "win32" && pid && c.proc.exitCode === null) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  return c.kill();
}

interface Started {
  child: Child;
  ui: number;
  app: () => number;
}
const started: Child[] = [];

async function start(fx: Fixture, args: string[], env: Record<string, string> = {}): Promise<Started> {
  const ui = await freePort();
  const child = run(
    args,
    fx.root,
    childEnv({
      HOPLENS_PATH: "1",
      HOPLENS_PORT: String(ui),
      HOPLENS_OPTIONS: JSON.stringify({ stateDir: path.join(fx.root, ".state"), persist: false }),
      ...env,
    }),
  );
  started.push(child);
  await child.waitFor("ready", 40000);
  const app = () => {
    const all = [...child.stdout().matchAll(/"ready":(\d+)/g)];
    return Number(all[all.length - 1]![1]);
  };
  return { child, ui, app };
}

/** Warm `p`, trace its path, and return the payload with its analysis. */
async function tracePath(s: Started, p: string): Promise<any> {
  for (let i = 0; i < 2; i++) expect((await request(s.app(), "GET", p)).status).toBe(200);
  const t = await poll(async () => {
    const list = (await json(s.ui, "GET", "/__hoplens/api/traces")).body as any[];
    return list.find((x) => x.done && x.method === "GET" && x.path === p && !x.pathTrace);
  });
  const r = await json(s.ui, "POST", `/__hoplens/api/traces/${t.id}/path`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.path;
}

const KEYS = {
  handler: "src/routes.ts:13:GET /api/run/:mode",
  classify: "src/branchy.ts:18:classify",
  scan: "src/branchy.ts:43:scan",
  guarded: "src/branchy.ts:57:guarded",
  dropped: "src/branchy.ts:69:dropped",
} as const;
const MAPPED = ["handler", "classify", "scan", "guarded"] as const;

/** The oracle is Node's own type stripping (22.6+ flag, default since 22.18): none on older Nodes. */
const STRIPS_TYPES = testNodeFeatures().typescript;
const P5_TITLE = `P5: TypeScript under every runner, against the type-stripping oracle${
  STRIPS_TYPES ? "" : ` (skipped: Node ${testNodeFeatures().version} has no type stripping, the oracle)`
}`;

let esm: Fixture;
let cjs: Fixture;
/** The ground truth: the stripped run's payload. */
let oracle: any;

beforeAll(async () => {
  if (!STRIPS_TYPES) return;
  const files = { "src/branchy.ts": BRANCHY, "src/routes.ts": ROUTES, "src/server.ts": SERVER };
  esm = makeFixture("express5", {
    ...files,
    "package.json": JSON.stringify({ name: "p5-esm", private: true, type: "module" }),
  });
  cjs = makeFixture("express5", {
    ...files,
    "package.json": JSON.stringify({ name: "p5-cjs", private: true, type: "commonjs" }),
  });
  const s = await start(esm, ["--import", REGISTER_URL, "src/server.ts"]);
  oracle = await tracePath(s, "/api/run/all");
  await killTree(s.child);
}, 60000);
afterAll(async () => {
  await Promise.all(started.map((c) => killTree(c)));
  esm?.cleanup();
  cjs?.cleanup();
});

/** Every mapped function's analysis is the oracle's; `dropped` is UNKNOWN 'unmapped'. */
function expectOracle(p: any, setup: string) {
  expect(p.quality, setup).toBe("exact");
  expect(p.analysis.text, setup).toBe(oracle.analysis.text);
  for (const k of MAPPED) {
    const f = p.functions[KEYS[k]];
    expect(f, `${setup} ${k}`).toMatchObject({ mapping: "sourcemap", truth: oracle.functions[KEYS[k]].truth });
    expect(f.analysis, `${setup} ${k}`).toEqual(oracle.functions[KEYS[k]].analysis);
    expect([f.startLine, f.endLine], `${setup} ${k}`).toEqual([
      oracle.functions[KEYS[k]].startLine,
      oracle.functions[KEYS[k]].endLine,
    ]);
  }
  const d = p.functions[KEYS.dropped];
  expect(d.truth, setup).toEqual({ t: "taken", n: 1 });
  expect(d.analysis, setup).toMatchObject({ status: "unknown", why: "unmapped" });
  expect(p.warnings.join("\n"), setup).toMatch(/dropped: not mapped to src\/branchy\.ts with certainty/);
}

describe.skipIf(!STRIPS_TYPES)(P5_TITLE, () => {
  test("oracle (node --import hoplens, Node's own type stripping): identity, exact, every decision counted", () => {
    expect(oracle.quality).toBe("exact");
    expect(oracle.analysis.text).toBe("Exited: end of GET /api/run/:mode L23");
    for (const k of [...MAPPED, "dropped"] as const) {
      const f = oracle.functions[KEYS[k]];
      expect(f, k).toMatchObject({ mapping: "identity" });
      expect(f.analysis.status, k).toBe("ok");
    }
    const c = oracle.functions[KEYS.classify].analysis;
    expect(c.decisions.map((d: any) => [d.line, d.label, d.arms.map((a: any) => a.count)])).toEqual([
      [20, "item.id < 0", [1, 1, 2]],
      [25, "high", [1, 1]],
      [27, "item.kind", [1, 0, 1, 1]],
    ]);
    expect(oracle.functions[KEYS.dropped].analysis.decisions[0].arms.map((a: any) => a.count)).toEqual([1, 0]);
  });

  test("tsx (COMPILED: tsx --import hoplens): the hook's retained output, mapped; same analysis as the oracle", async () => {
    const s = await start(esm, [TSX_CLI, "--import", REGISTER_URL, "src/server.ts"]);
    const p = await tracePath(s, "/api/run/all");
    expectOracle(p, "tsx esm");
    expect(p.functions[KEYS.classify].generated.via).toBe("hook");
    await killTree(s.child);
  }, 60000);

  test("tsx registered after Hoplens (RAW): UNKNOWN 'no-generated-text', never guessed; the Debugger read maps it", async () => {
    const s = await start(esm, ["--import", REGISTER_URL, "--import", TSX_LOADER, "src/server.ts"]);
    const p = await tracePath(s, "/api/run/all");
    for (const k of [...MAPPED, "dropped"] as const)
      expect(p.functions[KEYS[k]].truth, k).toEqual({ t: "unknown", why: "no-generated-text" });
    expect(p.analysis.text).toBe("Exit: UNKNOWN (no-generated-text)");
    expect(p.warnings.join("\n")).toMatch(/register Hoplens after it/);
    expect(p.window.debuggerMs).toBeUndefined();
    await killTree(s.child);

    const d = await start(esm, ["--import", REGISTER_URL, "--import", TSX_LOADER, "src/server.ts"], {
      HOPLENS_PATH_DEBUGGER: "1",
    });
    const q = await tracePath(d, "/api/run/all");
    expectOracle(q, "tsx raw + debugger");
    expect(q.functions[KEYS.classify].generated.via).toBe("debugger");
    expect(typeof q.window.debuggerMs).toBe("number");
    console.log(`P5 Debugger read of generated sources: ${q.window.debuggerMs}ms`);
    // The read must not cost the process its block counts: a later capture still works and maps.
    const q2 = await tracePath(d, "/api/run/all");
    expectOracle(q2, "tsx raw + debugger, second capture");
    expect(q2.functions[KEYS.classify].generated.via).toBe("debugger");
    await killTree(d.child);
  }, 90000);

  test("tsx CommonJS (tsx -r hoplens, a commonjs package): the CommonJS layer's retained output, mapped", async () => {
    const s = await start(cjs, [TSX_CLI, "-r", REGISTER, "src/server.ts"]);
    const p = await tracePath(s, "/api/run/all");
    expectOracle(p, "tsx cjs");
    await killTree(s.child);
  }, 60000);

  test("tsx watch: after an edit restarts the app, the new process maps its own output", async () => {
    const s = await start(esm, [TSX_CLI, "watch", "--import", REGISTER_URL, "src/server.ts"]);
    const first = s.app();
    expectOracle(await tracePath(s, "/api/run/all"), "tsx watch, first");
    const file = path.join(esm.root, "src", "branchy.ts");
    // A same-length edit outside every traced function: the analyses stay the oracle's.
    fs.writeFileSync(file, BRANCHY.replace("let ticks = 0;", "let ticks = 1;"));
    try {
      await poll(async () => (s.app() !== first ? true : undefined), 20000);
      await poll(
        async () => ((await request(s.app(), "GET", "/api/run/all")).status === 200 ? true : undefined),
        10000,
      );
      const p = await tracePath(s, "/api/run/all");
      expectOracle(p, "tsx watch, restarted");
    } finally {
      fs.writeFileSync(file, BRANCHY);
      await killTree(s.child);
    }
  }, 90000);

  test("node --watch with type stripping: identity across a restart (unchanged)", async () => {
    const s = await start(esm, ["--watch", "--import", REGISTER_URL, "src/server.ts"]);
    const first = s.app();
    const file = path.join(esm.root, "src", "branchy.ts");
    fs.writeFileSync(file, BRANCHY.replace("let ticks = 0;", "let ticks = 1;"));
    try {
      await poll(async () => (s.app() !== first ? true : undefined), 20000);
      await poll(
        async () => ((await request(s.app(), "GET", "/api/run/all")).status === 200 ? true : undefined),
        10000,
      );
      const p = await tracePath(s, "/api/run/all");
      expect(p.analysis.text).toBe(oracle.analysis.text);
      for (const k of MAPPED) {
        expect(p.functions[KEYS[k]].mapping, k).toBe("identity");
        expect(p.functions[KEYS[k]].analysis, k).toEqual(oracle.functions[KEYS[k]].analysis);
      }
    } finally {
      fs.writeFileSync(file, BRANCHY);
      await killTree(s.child);
    }
  }, 90000);
});
