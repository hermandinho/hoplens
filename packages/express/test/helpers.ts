// Spawned-process harness. The register hook, the gate and the singleton are per process, so these
// tests run the built dist/ (the test script builds first) in child processes, against a temp app
// root whose node_modules/express links to the express4 or express5 dev dependency.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { TEST_NODE, withTestNode } from "./test-node";

export const PKG = path.resolve(__dirname, "..");
export const REGISTER = path.join(PKG, "dist", "register.js");
export const INDEX = path.join(PKG, "dist", "index.js");
export const ESM_INDEX = path.join(PKG, "esm", "index.mjs");

export type ExpressAlias = "express4" | "express5";

export interface Fixture {
  root: string;
  cleanup(): void;
}

/** A temp app root: package.json, plus node_modules/express linked to `alias` when given. */
export function makeFixture(alias?: ExpressAlias, files: Record<string, string> = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-express-")));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-app", private: true }));
  const link = path.join(root, "node_modules", "express");
  if (alias) {
    const target = path.dirname(require.resolve(`${alias}/package.json`, { paths: [PKG] }));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(fs.realpathSync(target), link, "junction");
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return {
    root,
    cleanup() {
      // Unlink the junction first so the recursive delete can never walk into the real express.
      try {
        if (alias) fs.unlinkSync(link);
      } catch {
        /* already gone */
      }
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort on Windows */
      }
    },
  };
}

/** A port nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** True when something accepts connections on the port. */
export function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

/**
 * Env for a child: vitest's NODE_ENV=test, any HOPLENS_* from the parent and pnpm's NODE_PATH (which
 * would resolve the workspace's express from any root) are dropped.
 */
export function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      k === "NODE_ENV" ||
      k.startsWith("HOPLENS") ||
      k.startsWith("VITEST") ||
      k === "NODE_OPTIONS" ||
      k === "NODE_PATH"
    )
      continue;
    env[k] = v;
  }
  withTestNode(env);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export interface Child {
  proc: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Resolves with the first stdout line that parses as JSON and has `key`. */
  waitFor<T = any>(key: string, timeoutMs?: number): Promise<T>;
  exited: Promise<number | null>;
  kill(): Promise<void>;
}

/** `stdin`: pipe the child's stdin (for a test that signals it), else ignored. */
export function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin = false): Child {
  const proc = spawn(TEST_NODE, args, { cwd, env, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const waiters: Array<() => void> = [];
  proc.stdout!.on("data", (c) => {
    out += c;
    for (const w of waiters.slice()) w();
  });
  proc.stderr!.on("data", (c) => {
    err += c;
  });
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  return {
    proc,
    stdout: () => out,
    stderr: () => err,
    exited,
    waitFor(key, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          for (const line of out.split(/\r?\n/)) {
            if (!line.startsWith("{")) continue;
            try {
              const v = JSON.parse(line);
              if (v && key in v) {
                waiters.splice(waiters.indexOf(check), 1);
                clearTimeout(timer);
                resolve(v);
                return;
              }
            } catch {
              /* not ours */
            }
          }
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`timed out waiting for "${key}"\nstdout:\n${out}\nstderr:\n${err}`));
        }, timeoutMs);
        waiters.push(check);
        exited.then(() => setTimeout(check, 0));
        check();
      });
    },
    async kill() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await exited;
    },
  };
}

export async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timed out${last ? `: ${String(last)}` : ""}`);
}

/** Count of startup banners in a child's stdout. */
export function bannerCount(stdout: string): number {
  return stdout.split("◆ Hoplens").length - 1;
}
