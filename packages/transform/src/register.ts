// Node `module.register()` hook for non-bundled frameworks (Nest, Express, Fastify). Published
// as a stable import surface so adapters can wire it without conditional imports. The actual
// registration lands with the first non-Next adapter.

import type { TransformOptions } from "./index";

export interface RegisterOptions extends TransformOptions {
  framework?: "nest" | "express" | "fastify" | "koa" | string;
}

export function register(_opts: RegisterOptions = { root: process.cwd() }): () => void {
  return () => {};
}
