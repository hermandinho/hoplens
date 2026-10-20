import fs from "node:fs";
import path from "node:path";

export function readJson(p: string | null): any | null {
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function safeResolve(id: string, root: string): string | null {
  try {
    return require.resolve(id, { paths: [root] });
  } catch {
    return null;
  }
}

/**
 * `<name>/package.json` as the project's own node would find it: node_modules of root and its
 * ancestors only. Unlike require.resolve this ignores NODE_PATH, which pnpm's bin shims set to the
 * store's hoisted folder, so a package the app can't load isn't reported as installed.
 */
export function projectPackageJson(name: string, root: string): string | null {
  let dir = path.resolve(root);
  for (;;) {
    const p = path.join(dir, "node_modules", ...name.split("/"), "package.json");
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
