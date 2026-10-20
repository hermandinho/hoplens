// Whether Hoplens runs in this process. Pure env reads with no imports, so `register` can decide
// before anything loads @hoplens/core: with the gate off, the app's process never sees the runtime.

export type Env = Record<string, string | undefined>;

/**
 * On when NODE_ENV is unset (plain `node server.js`) or anything but production/test. Off for
 * NODE_ENV=production or test unless HOPLENS_FORCE=1, and always off for HOPLENS=0.
 */
export function shouldStart(env: Env = process.env): boolean {
  if (env.HOPLENS === "0") return false;
  const mode = env.NODE_ENV;
  if ((mode === "production" || mode === "test") && env.HOPLENS_FORCE !== "1") return false;
  return true;
}

/**
 * HOPLENS_PATH=1 (or true). Same rule as @hoplens/core/coverage pathFlag(). The register hook's full
 * decision (HOPLENS_PATH=0 and the sticky flag file too) is pathDecision() in pathflag.ts.
 */
export function pathRequested(env: Env = process.env): boolean {
  const v = env.HOPLENS_PATH;
  return v === "1" || v?.toLowerCase() === "true";
}
