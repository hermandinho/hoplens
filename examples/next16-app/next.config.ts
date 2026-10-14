import { withHoplens } from "@hoplens/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
};

export default withHoplens(nextConfig);
