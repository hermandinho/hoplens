import fs from "node:fs";

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
