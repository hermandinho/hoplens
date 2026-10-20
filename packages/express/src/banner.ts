import type { Runtime } from "@hoplens/core";
import type { PathSource } from "./pathflag";
import { type AutoTraceStats, adapterState } from "./state";

/** Banner note with `persist: false`: no manifest, so a restart is never matched to the files it changed. */
export const PERSIST_OFF_NOTE = "persist is off: edits across restarts are not tracked (each start is one epoch)";

/** How long to wait for the app's own 'listening' once the UI server is up. */
const APP_WAIT_MS = 1500;

/** Runtime banner hook: the UI server is up (or gave up on its port). */
export function uiReady(rt: Runtime): void {
  const b = adapterState().banner;
  b.uiReady = true;
  b.rt = rt;
  // A late boot (hoplens() after the app listened) has no 'listening' left to wait for.
  if (b.appPort !== undefined || b.noAppListen) {
    print();
    return;
  }
  if (!b.timer) {
    b.timer = setTimeout(print, APP_WAIT_MS);
    b.timer.unref();
  }
}

/** The app's server bound this port (its 'listening' event, not process.env.PORT). */
export function appListening(port: number): void {
  const b = adapterState().banner;
  b.appPort = port;
  if (b.uiReady) print();
}

/** @hoplens/transform/register's flushReports(), read off its global: the banner never loads the transform. */
const FLUSH = Symbol.for("hoplens.transform.flush");

/**
 * Print once. With function hops on, first wait until the hooks worker's reports so far arrived (they
 * come on the event loop, and a file the transform cache answers costs the hook no time, so its report
 * can trail the app's listen): the count is then the files loaded before the app listened.
 */
function print(): void {
  const s = adapterState();
  const b = s.banner;
  if (b.printed || b.flushing || !b.rt) return;
  const flush = (globalThis as any)[FLUSH];
  if (s.autoTrace && typeof flush === "function") {
    b.flushing = true;
    if (b.timer) clearTimeout(b.timer);
    try {
      flush(printNow);
      return;
    } catch {
      /* print now */
    }
  }
  printNow();
}

function printNow(): void {
  const s = adapterState();
  const b = s.banner;
  if (b.printed || !b.rt) return;
  b.printed = true;
  if (b.timer) clearTimeout(b.timer);
  try {
    const notes: string[] = [];
    if (!s.express) notes.push(`Could not resolve express from ${b.rt.root}; is it installed there?`);
    if (b.rt.options.persist === false) notes.push(PERSIST_OFF_NOTE);
    const info: string[] = [];
    const path = pathBanner();
    if (path?.info) info.push(path.info);
    if (path?.note) notes.push(path.note);
    if (s.autoTrace) {
      const hops = functionHopsLine(s.autoTrace);
      if (hops) info.push(hops);
      const refused = refusedNote(s.autoTrace);
      if (refused) notes.push(refused);
    }
    process.stdout.write(bannerText(b.rt.uiPort, b.appPort, notes, info));
  } catch {
    /* a closed stdout never breaks the app */
  }
}

/** The request path's coverage handle (@hoplens/core/coverage), read off its global: no import. */
const COVERAGE = Symbol.for("hoplens.coverage");

/** `request path: on (HOPLENS_PATH)` / `request path: on (flag; disable in the Path tab)`. */
export function pathOnLine(source: PathSource | undefined): string {
  return source === "flag" ? "request path: on (flag; disable in the Path tab)" : "request path: on (HOPLENS_PATH)";
}

/** Set by HOPLENS_PATH. Kept for callers of the P1 name. */
export const PATH_ON_LINE = pathOnLine("env");

/**
 * Banner lines for the request path, or undefined when it was not asked for at boot (no coverage
 * handle). `source` says who asked: HOPLENS_PATH or the sticky flag. Exported for tests.
 */
export function pathBanner(
  cov: { state?: string; reason?: string } | undefined = (globalThis as any)[COVERAGE],
  source: PathSource | undefined = adapterState().path?.source,
): { info?: string; note?: string } | undefined {
  if (!cov) return undefined;
  if (cov.state === "on") return { info: pathOnLine(source) };
  if (cov.state === "disabled-c8")
    return { note: "request path disabled: NODE_V8_COVERAGE is set (c8 owns V8 coverage); unset it to use Trace path" };
  const silence =
    source === "flag" ? "disable it in the Path tab to silence this" : "unset HOPLENS_PATH to silence this";
  if (cov.state === "error")
    return {
      note: `request path failed to start: ${cov.reason ?? "coverage did not start"}; the app runs without it (${silence})`,
    };
  return { note: `request path off: ${cov.reason ?? cov.state ?? "coverage did not start"}` };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** HOPLENS_DEBUG is set (any value but empty or 0). Same test as autotrace.ts debugSet(). */
const debugSet = (env: Record<string, string | undefined>) => {
  const v = env.HOPLENS_DEBUG?.trim();
  return !!v && v !== "0";
};

/**
 * `function hops: 5 fns in 3 files`, or undefined when nothing was wrapped. With HOPLENS_DEBUG set,
 * ` (cache: K hits)` (or ` (cache: off)`) follows. Exported for tests.
 */
export function functionHopsLine(
  st: AutoTraceStats,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!st.fns) return undefined;
  const cache = debugSet(env) ? (st.cacheDir ? ` (cache: ${plural(st.cacheHits ?? 0, "hit")})` : " (cache: off)") : "";
  return `function hops: ${plural(st.fns, "fn")} in ${plural(st.files, "file")}${cache}`;
}

/** Where the debug log that lists each refused file is turned on. */
export const DEBUG_HINT = "HOPLENS_DEBUG=transform lists each file and why";

/**
 * One line for every file loaded untouched, with the fix where there is one, by the reason names the
 * transform reports (compiled, unmapped, commonjs, esm-loader, large: the debug log's `refused=` and
 * `hoplens doctor` use the same). Ends with DEBUG_HINT unless the log is already on. Exported for tests.
 */
export function refusedNote(
  st: AutoTraceStats,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const parts: string[] = [];
  const compiled = st.refused.compiled ?? 0;
  const cjs = st.refused.commonjs ?? 0;
  if (compiled) {
    parts.push(
      `${plural(compiled, "file")} compiled by another loader (tsx?) before Hoplens saw ${compiled === 1 ? "it" : "them"}; load Hoplens first: node --import hoplens/express/register --import tsx <entry>`,
    );
  }
  const unmapped = st.refused.unmapped ?? 0;
  if (unmapped) {
    const first = st.firstRefused?.unmapped;
    const where = first
      ? ` (${first.file}${first.detail ? `: ${first.detail}` : ""}${unmapped > 1 ? ", ..." : ""})`
      : "";
    parts.push(
      `${plural(unmapped, "TypeScript file")} whose compiled output (tsx?) Hoplens could not map back to the source${where}; to wrap ${unmapped === 1 ? "it" : "them"}, load Hoplens first: node --import hoplens/express/register --import tsx <entry>`,
    );
  }
  if (cjs) parts.push(`${plural(cjs, "CommonJS file")} another loader compiled for Node's ESM loader`);
  const viaEsm = st.refused["esm-loader"] ?? 0;
  if (viaEsm) {
    const first = st.firstRefused?.["esm-loader"];
    parts.push(
      `${plural(viaEsm, "CommonJS file")} Node loaded through its ESM loader${first ? ` (${first.file}${viaEsm > 1 ? ", ..." : ""})` : ""}, as it does for the entry under --import and for a CommonJS file imported from ESM; for a CommonJS entry, preload with -r hoplens/express/register instead of --import`,
    );
  }
  const large = st.refused.large ?? 0;
  if (large) parts.push(`${plural(large, "file")} over 1 MB (generated code?), not parsed`);
  if (!parts.length) return undefined;
  // The debug log is on: same test as @hoplens/transform/register transformDebug() (not imported here,
  // so the banner never loads the transform).
  const hint = /(?:^|[\s,])(?:transform|1|\*|all|true)(?:$|[\s,])/i.test(env.HOPLENS_DEBUG?.trim() ?? "")
    ? ""
    : ` (${DEBUG_HINT})`;
  return `function hops skipped for ${parts.join("; ")}${hint}`;
}

/** Exported for tests. `info` lines print under the URL, before the `!` notes. */
export function bannerText(
  uiPort: number | undefined,
  appPort: number | undefined,
  notes: string[] = [],
  info: string[] = [],
): string {
  const standalone = uiPort ? `http://127.0.0.1:${uiPort}` : undefined;
  let line: string;
  if (appPort) line = `http://localhost:${appPort}/__hoplens${standalone ? `  (also ${standalone})` : ""}`;
  else line = standalone ?? "/__hoplens on your app's port";
  const lines = info.length ? `\n   ${info.join("\n   ")}` : "";
  const suffix = `${lines}${notes.length ? `\n   ! ${notes.join("\n   ! ")}` : ""}`;
  return `\n \x1b[35m◆ Hoplens\x1b[0m  ${line}${suffix}\n\n`;
}
