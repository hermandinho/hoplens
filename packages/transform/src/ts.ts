import { createRequire } from "node:module";
import path from "node:path";

let cached: { root: string; ts: any } | null = null;

// TypeScript 7 is a native rewrite with no JS API, so we ship our own TS 5/6 and prefer it over
// whatever the host project resolves. Falls back to the project's copy only when ours is missing.
export function loadTypeScript(root: string): any | null {
  if (cached && cached.root === root) return cached.ts;
  let ts: any = null;
  for (const base of [__dirname, root]) {
    try {
      const mod = createRequire(path.join(base, "package.json"))("typescript");
      if (typeof mod?.createSourceFile === "function") {
        ts = mod;
        break;
      }
    } catch {
      /* try next */
    }
  }
  cached = { root, ts };
  return ts;
}

/** TypeScript was loaded in this thread (by loadTypeScript). For the debug log and tests. */
export function typescriptLoaded(): boolean {
  return Boolean(cached?.ts);
}
