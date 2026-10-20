import { vi } from "vitest";
import type { makeFixture } from "./fixture";

type Fx = ReturnType<typeof makeFixture>;

export type SeedOptions = {
  scripts?: Record<string, string>;
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  type?: "module" | "commonjs";
  indent?: number;
  crlf?: boolean;
  extra?: Record<string, unknown>;
};

/** An Express-shaped project: package.json declaring express (and the hoplens meta unless overridden). */
export function seedExpress(fx: Fx, opts: SeedOptions = {}): string {
  const pkg: Record<string, unknown> = { name: "fx-express", version: "1.0.0" };
  if (opts.type) pkg.type = opts.type;
  if (opts.scripts) pkg.scripts = opts.scripts;
  pkg.dependencies = opts.deps ?? { express: "^5.1.0" };
  pkg.devDependencies = opts.devDeps ?? { hoplens: "^0.3.0" };
  Object.assign(pkg, opts.extra);
  let text = `${JSON.stringify(pkg, null, opts.indent ?? 2)}\n`;
  if (opts.crlf) text = text.replace(/\n/g, "\r\n");
  fx.write("package.json", text);
  // A repo root, so the package-manager lookup never reads lockfiles above the temp dir.
  fx.write(".git/HEAD", "ref: refs/heads/main\n");
  return text;
}

/** Fake installed packages under node_modules, where the project-only lookup (and require.resolve) finds them. */
export function installFake(fx: Fx, name: string, version: string) {
  fx.write(`node_modules/${name}/package.json`, JSON.stringify({ name, version }));
  fx.write(`node_modules/${name}/index.js`, "module.exports = {};");
}

/** Collect console.log output (ANSI stripped) for the duration of the returned handle. */
export function captureConsole() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(
      args
        .map(String)
        .join(" ")
        .replace(/\x1b\[[0-9;]*m/g, ""),
    );
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

export function devScript(fx: Fx, key = "dev"): string {
  return JSON.parse(fx.read("package.json")).scripts[key];
}
