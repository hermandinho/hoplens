// Runs the workspace's real tsx on the TypeScript fixtures under fixture/tsx and returns what its ESM
// loader hands the next hook: the source COMPILED mode sees under `tsx --import hoplens/...`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TSX_FIXTURES = path.join(__dirname, "fixture", "tsx");

/** The installed tsx: its CLI and version, or undefined when the workspace has none. */
export function installedTsx(): { cli: string; version: string } | undefined {
  try {
    const pkgPath = createRequire(path.join(__dirname, "..", "package.json")).resolve("tsx/package.json");
    const cli = path.join(path.dirname(pkgPath), "dist", "cli.mjs");
    if (!fs.existsSync(cli)) return undefined;
    return { cli, version: JSON.parse(fs.readFileSync(pkgPath, "utf8")).version };
  } catch {
    return undefined;
  }
}

/** The raw fixture cases: every `.ts` file in fixture/tsx. */
export function tsxCases(): string[] {
  return fs
    .readdirSync(TSX_FIXTURES)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** Where the pinned output of `name` compiled by tsx `version` lives. */
export const compiledFixture = (name: string, version: string) => path.join(TSX_FIXTURES, `${name}.tsx-${version}.mjs`);

const FIXTURE_RE = /\.tsx-(.+)\.mjs$/;

/** The tsx version the pinned fixtures come from, read off their file names: exactly one, or it throws. */
export function pinnedTsxVersion(dir = TSX_FIXTURES): string {
  const versions = [...new Set(fs.readdirSync(dir).flatMap((f) => FIXTURE_RE.exec(f)?.[1] ?? []))];
  if (versions.length !== 1)
    throw new Error(
      `fixture/tsx must hold the output of exactly one tsx version, found: ${versions.join(", ") || "none"}`,
    );
  return versions[0]!;
}

/** Pins `compiled` as the output of tsx `version`, removing every other version's fixtures. */
export function pinTsxFixtures(compiled: Record<string, string>, version: string, dir = TSX_FIXTURES): void {
  for (const f of fs.readdirSync(dir)) {
    const v = FIXTURE_RE.exec(f)?.[1];
    if (v && v !== version) fs.rmSync(path.join(dir, f));
  }
  for (const [name, src] of Object.entries(compiled))
    fs.writeFileSync(path.join(dir, `${name}.tsx-${version}.mjs`), src);
}

/**
 * The inline source map with its `sources` made relative (the absolute temp path would differ per run
 * and per machine). Only the comment after the code changes: every byte of code stays as tsx wrote it.
 */
export function normalizeMap(compiled: string, name: string): string {
  return compiled.replace(
    /(\/\/# sourceMappingURL=data:application\/json;base64,)([A-Za-z0-9+/=]+)\s*$/,
    (_m, head: string, b64: string) => {
      const map = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      map.sources = [`${name}.ts`];
      // tsx writes [null] unless NODE_V8_COVERAGE is set, then the source itself: pin the former.
      if (map.sourcesContent) map.sourcesContent = map.sourcesContent.map(() => null);
      return head + Buffer.from(JSON.stringify(map)).toString("base64");
    },
  );
}

/**
 * Compiles each case with `tsx <entry> --import <dump hook>`: the hook registers after tsx's loader,
 * so its load sees tsx's output, and writes it out. Returns case name -> normalized compiled source.
 */
export function compileWithTsx(cli: string, cases = tsxCases()): Record<string, string> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-tsx-")));
  try {
    const out = path.join(dir, "out");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    for (const c of tsxCases()) fs.copyFileSync(path.join(TSX_FIXTURES, `${c}.ts`), path.join(dir, "src", `${c}.ts`));
    fs.writeFileSync(
      path.join(dir, "dump.mjs"),
      `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.startsWith("file:") && url.includes("/src/") && r.source != null) {
    const name = path.basename(fileURLToPath(url)).replace(/\\.ts$/, "");
    fs.writeFileSync(path.join(${JSON.stringify(out)}, name + ".mjs"), typeof r.source === "string" ? r.source : Buffer.from(r.source));
  }
  return r;
}
`,
    );
    fs.writeFileSync(
      path.join(dir, "dump-register.mjs"),
      `import { register } from "node:module";\nregister("./dump.mjs", import.meta.url);\n`,
    );
    fs.writeFileSync(
      path.join(dir, "entry.mjs"),
      cases
        .map((c) => `await import(${JSON.stringify(pathToFileURL(path.join(dir, "src", `${c}.ts`)).href)});`)
        .join("\n"),
    );
    const env = { ...process.env };
    // NODE_V8_COVERAGE (c8, vitest coverage) makes tsx add sourcesContent to its inline map.
    for (const k of Object.keys(env))
      if (k.startsWith("VITEST") || k === "NODE_OPTIONS" || k === "NODE_V8_COVERAGE") delete env[k];
    const r = spawnSync(process.execPath, [cli, "--import", "./dump-register.mjs", "entry.mjs"], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    if (r.status !== 0) throw new Error(`tsx failed (${r.status}):\n${r.stderr}`);
    const result: Record<string, string> = {};
    for (const c of cases) {
      const file = path.join(out, `${c}.mjs`);
      if (!fs.existsSync(file)) throw new Error(`tsx did not load ${c}.ts`);
      result[c] = normalizeMap(fs.readFileSync(file, "utf8"), c);
    }
    return result;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  }
}
