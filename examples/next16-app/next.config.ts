import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite (in-process Postgres for the /api/db demos) loads its WASM and data files from its own
  // package directory, so it must stay a plain Node require. `pg` is already on Next's built-in list.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default async (phase: string, ctx: { defaultConfig: NextConfig }) => {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;
  // Hoplens is a dev dependency: only `next dev` loads it
  const { withHoplens } = await import("hoplens/next" as string);
  return withHoplens(nextConfig)(phase, ctx);
};
