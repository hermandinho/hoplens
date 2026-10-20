// The Node that spawned-process tests run their children on: HOPLENS_TEST_NODE (an absolute node
// binary, e.g. a portable 20.9 build, to run the runner matrix without changing the machine's Node)
// or the Node running vitest. Its directory goes first in the child's PATH so a runner that spawns
// `node` by name stays on it.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export const TEST_NODE = process.env.HOPLENS_TEST_NODE || process.execPath;

/** `env` with TEST_NODE's directory first in PATH (mutates and returns it). */
export function withTestNode<T extends NodeJS.ProcessEnv>(env: T): T {
  if (TEST_NODE === process.execPath) return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  (env as NodeJS.ProcessEnv)[key] = path.dirname(TEST_NODE) + path.delimiter + (env[key] ?? "");
  return env;
}

export interface TestNodeFeatures {
  version: string;
  /** Node strips types itself (`process.features.typescript`, on by default since 22.18 / 23.6). */
  typescript: boolean;
  /** The hook API @hoplens/transform's register() picks there (`sync`: module.registerHooks, in-thread). */
  hookApi: "sync" | "async";
  /** `--import` modules evaluate in flag order (Node 20.9 / 20.10 run tsx's late: RAW, never COMPILED). */
  importOrdered: boolean;
}

let features: TestNodeFeatures | undefined;
/** TEST_NODE's features, probed on that Node (not on the one running vitest). Needs the built transform. */
export function testNodeFeatures(): TestNodeFeatures {
  if (features) return features;
  const reg = JSON.stringify(
    createRequire(path.join(__dirname, "..", "package.json")).resolve("@hoplens/transform/register"),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "" };
  Reflect.deleteProperty(env, "HOPLENS_LOADER_HOOKS");
  const r = spawnSync(
    TEST_NODE,
    [
      "-p",
      `const r = require(${reg}); JSON.stringify({ version: process.version, typescript: Boolean(process.features.typescript), hookApi: r.hookApi(), importOrdered: r.importOrderHonored() })`,
    ],
    { encoding: "utf8", env },
  );
  features = JSON.parse(r.stdout.trim()) as TestNodeFeatures;
  return features;
}
