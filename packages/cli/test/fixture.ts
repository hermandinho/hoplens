import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

/**
 * Create a disposable temp-dir "project" for CLI tests. Returns helpers that always
 * operate relative to the fixture root. Cleanup is best-effort and swallows errors
 * so a stuck Windows file handle doesn't fail the suite.
 */
export function makeFixture(prefix = "hoplens-cli-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  function abs(p: string) {
    return path.join(dir, p);
  }
  function write(p: string, content: string) {
    const full = abs(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  function read(p: string) {
    return fs.readFileSync(abs(p), "utf8");
  }
  function exists(p: string) {
    return fs.existsSync(abs(p));
  }
  function cleanup() {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore — vitest will tear down the tmp dir eventually
    }
  }

  return { dir, abs, write, read, exists, cleanup };
}

/**
 * Minimal greenfield Next-shaped project: package.json declaring `next`, a tsconfig
 * so the TS AST loads, and nothing else. Caller adds a next.config / instrumentation
 * if they want to exercise a specific starting state.
 */
export function seedGreenfield(fx: ReturnType<typeof makeFixture>) {
  fx.write("package.json", JSON.stringify({ name: "fx", dependencies: { next: "^16.0.0" } }, null, 2));
  fx.write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
}

/**
 * Swap process.cwd() to the fixture dir for the duration of `fn`, then restore it
 * even if `fn` throws. CLI commands read cwd internally so tests need this instead
 * of threading `root` through.
 */
export async function withCwd<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

/**
 * Mute `console.log` for the duration of a test. CLI commands print banners and
 * progress to stdout; verifying file state is what we care about in tests, so
 * silencing keeps the vitest output readable.
 */
export function muteConsole() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  return () => spy.mockRestore();
}
