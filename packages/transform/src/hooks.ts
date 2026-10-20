// ESM load hook, built to dist/hooks.mjs and registered by register.ts with `module.register()`. Runs
// in Node's hooks worker. The load step itself (RAW / COMPILED mode, the request path's retention, the
// transform cache) is src/esmload.ts, which register.ts also runs on the main thread through
// `module.registerHooks()` on the Nodes where tsx does (hookApi()). Here it reports to the
// main thread over the MessagePort in `data.port`, which also carries `disable` and `flush` in.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type EsmLoader, type LoadResult, createEsmLoader } from "./esmload";
import type { HookData } from "./register";

type Transform = typeof import("./index");

type NextLoad = (url: string, context?: unknown) => Promise<LoadResult>;

interface Port {
  postMessage(m: unknown): void;
  on?(event: "message", fn: (m: unknown) => void): void;
  unref?(): void;
}

let loader: EsmLoader | undefined;
let tx: Transform | undefined;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The pure transform (dist/index.js). It loads TypeScript itself, only when a file gets parsed. */
function transform(): Transform {
  tx ??= createRequire(import.meta.url)("./index.js") as Transform;
  return tx;
}

export function initialize(data: HookData | undefined): void {
  if (!data || typeof data.root !== "string") return;
  const port = data.port as Port | undefined;
  const l = createEsmLoader(data, {
    post: (m) => port?.postMessage(m),
    transform,
    typescriptLoaded: () => Boolean(tx?.typescriptLoaded()),
    distDir: HERE,
    thread: "hooks",
  });
  loader = l;
  try {
    port?.on?.("message", (m) => {
      const msg = m as { type?: unknown; id?: unknown } | null;
      if (msg?.type === "disable") l.disable();
      // Every report this worker posted is ahead of the answer on the same port (in order).
      else if (msg?.type === "flush") port?.postMessage({ type: "flushed", id: msg.id });
    });
    port?.unref?.();
  } catch {
    /* reports are best effort */
  }
}

export async function load(url: string, context: unknown, nextLoad: NextLoad): Promise<LoadResult> {
  const r = await nextLoad(url, context);
  return loader ? loader.load(url, r) : r;
}
