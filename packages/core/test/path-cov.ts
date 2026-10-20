// Real V8 block coverage for the request-path truth tests: one inspector session for the test file,
// fixtures required (natively, so offsets are the file's) only after precise coverage started.
import fs from "node:fs";
import inspector from "node:inspector";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildCfg } from "../../transform/src/cfg";
import { loadTypeScript } from "../../transform/src/ts";
import type { CfgFile } from "../src/path/cfg-model";
import { type FnAnalysis, type RangeIn, joinCfg, pathTruth } from "../src/path/truth";

let session: inspector.Session | undefined;

function post<T = any>(method: string, params?: object): T {
  let out: T | undefined;
  let err: Error | null = null;
  session!.post(method, params ?? {}, (e: Error | null, v?: object) => {
    err = e;
    out = v as T;
  });
  if (err) throw err;
  return out as T;
}

/** Start precise block coverage (once per test file). */
export function startCoverage(): void {
  if (session) return;
  session = new inspector.Session();
  session.connect();
  post("Profiler.enable");
  post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
}

const req = createRequire(__filename);

export function load<T = any>(abs: string): T {
  return req(abs) as T;
}

export interface FnCoverage {
  functionName: string;
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  isBlockCoverage: boolean;
}

/** Reset the counters, run `fn` (awaited), and return the coverage of `abs`'s functions. */
export async function capture(abs: string, fn: () => unknown): Promise<FnCoverage[]> {
  post("Profiler.takePreciseCoverage");
  try {
    await fn();
  } catch {
    /* the run's own exception: the counts are what we want */
  }
  await new Promise((r) => setImmediate(r));
  const { result } = post<{ result: Array<{ url: string; functions: FnCoverage[] }> }>("Profiler.takePreciseCoverage");
  const url = pathToFileURL(abs).href;
  return result.find((s) => s.url === url)?.functions ?? [];
}

const ts = loadTypeScript(process.cwd());

/**
 * The production per-file parse budget (250ms) is wall time: under a loaded parallel test run a
 * small fixture can blow it and fold to 'too-large'. Tests get a generous budget unless they are
 * testing the budget itself (they pass their own maxMs).
 */
export const TEST_CFG_MS = 10_000;

export function cfgOf(abs: string, text = fs.readFileSync(abs, "utf8"), opts?: { maxMs?: number }): CfgFile {
  return buildCfg(ts, text, abs, { maxMs: TEST_CFG_MS, ...opts }) as unknown as CfgFile;
}

export function rangesOf(cov: FnCoverage[], name: string): RangeIn[] {
  const f = cov.find((x) => x.functionName === name);
  if (!f) throw new Error(`no coverage for ${name}`);
  if (!f.isBlockCoverage) throw new Error(`${name}: no block coverage`);
  return f.ranges.map((r) => ({ start: r.startOffset, end: r.endOffset, count: r.count }));
}

/** Join + truth for one function of a fixture, as the payload builder does it. */
export function analyze(
  abs: string,
  cov: FnCoverage[],
  name: string,
  extra: { threw?: number; throwLines?: number[] } = {},
): FnAnalysis {
  const ranges = rangesOf(cov, name);
  const j = joinCfg({ cfg: cfgOf(abs), ranges, capturedHash: "h", currentHash: "h" });
  if ("why" in j) throw new Error(`${name}: join failed: ${j.why}`);
  return pathTruth({ fn: j.fn, ranges, threw: extra.threw ?? 0, throwLines: extra.throwLines });
}

/** `label: arm=count|?` per decision, for compact asserts. */
export function arms(a: FnAnalysis): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of a.decisions)
    out[`L${d.line} ${d.label}`] = d.arms
      .map((x) => `${x.label}=${x.taken === "unknown" ? `?${x.why}` : x.count}`)
      .join(" ");
  return out;
}

export const FIXTURES = path.join(__dirname, "fixtures", "path");
