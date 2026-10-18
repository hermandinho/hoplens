import type { Runtime } from "@hoplens/core";
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

function print(): void {
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `function hops: 5 fns in 3 files`, or undefined when nothing was wrapped. Exported for tests. */
export function functionHopsLine(st: AutoTraceStats): string | undefined {
  if (!st.fns) return undefined;
  return `function hops: ${plural(st.fns, "fn")} in ${plural(st.files, "file")}`;
}

/** One line for every file loaded untouched, with the fix where there is one. Exported for tests. */
export function refusedNote(st: AutoTraceStats): string | undefined {
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
  return parts.length ? `function hops skipped for ${parts.join("; ")}` : undefined;
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
