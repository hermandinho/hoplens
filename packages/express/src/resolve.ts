import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface ExpressInfo {
  version?: string;
  /** The resolved `express/package.json`. */
  packageJson: string;
}

/**
 * The app's own express, resolved from its root (as core resolves `pg`), not from Hoplens's
 * dependency tree. Undefined when it can't be resolved; never throws.
 */
export function resolveExpress(root: string): ExpressInfo | undefined {
  try {
    const req = createRequire(path.join(root, "package.json"));
    const packageJson = req.resolve("express/package.json");
    let version: string | undefined;
    try {
      const v = JSON.parse(fs.readFileSync(packageJson, "utf8")).version;
      if (typeof v === "string") version = v;
    } catch {
      /* version is optional */
    }
    return { version, packageJson };
  } catch {
    return undefined;
  }
}
