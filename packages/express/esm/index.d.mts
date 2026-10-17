// Types for the hand-written ESM entry (esm/index.mjs). The CJS dist/index.d.ts is read as CommonJS
// (the package is type commonjs), so its `export default` would type a default import as the module
// object; this file types it as the function esm/index.mjs really exports.
import type { HoplensOptions, Runtime } from "@hoplens/core";

export declare function hoplens(app?: unknown, opts?: HoplensOptions): Runtime | undefined;
export default hoplens;
export type { HoplensOptions, HoplensProfile } from "@hoplens/core";
