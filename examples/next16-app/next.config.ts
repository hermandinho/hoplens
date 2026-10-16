import { withHoplens } from "@hoplens/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite (in-process Postgres for the /api/db demos) loads its WASM and data files from its own
  // package directory, so it must stay a plain Node require. `pg` is already on Next's built-in list.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default withHoplens(nextConfig);
