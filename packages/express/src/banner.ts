import type { Runtime } from "@hoplens/core";
import { adapterState } from "./state";

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
    process.stdout.write(bannerText(b.rt.uiPort, b.appPort, notes));
  } catch {
    /* a closed stdout never breaks the app */
  }
}

/** Exported for tests. */
export function bannerText(uiPort: number | undefined, appPort: number | undefined, notes: string[] = []): string {
  const standalone = uiPort ? `http://127.0.0.1:${uiPort}` : undefined;
  let line: string;
  if (appPort) line = `http://localhost:${appPort}/__hoplens${standalone ? `  (also ${standalone})` : ""}`;
  else line = standalone ?? "/__hoplens on your app's port";
  const suffix = notes.length ? `\n   ! ${notes.join("\n   ! ")}` : "";
  return `\n \x1b[35m◆ Hoplens\x1b[0m  ${line}${suffix}\n\n`;
}
