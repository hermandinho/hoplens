import type { NextConfig } from "next";
import { withHoplens } from "@hoplens/next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
};

export default withHoplens(nextConfig);
