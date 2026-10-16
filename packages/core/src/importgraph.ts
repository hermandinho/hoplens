// "Which routes does this edit affect?" for the Changes view (plan 3.5 / WP9a).
//
// A static, regex-based import graph walked from each route file: relative specifiers and tsconfig /
// jsconfig `paths` aliases (`@/*`) are followed, bare package specifiers are not. It over-approximates
// (type-only imports count, dynamic imports count) and that is the right side to err on: a route listed
// as affected that turns out unchanged reads "unchanged"; a missed route would hide a regression.
// Only used by the /api/epochs and /api/regressions handlers, never on the request path. Parses are
// cached by mtime, so a repeat call costs one stat per reachable file.

import fs from "node:fs";
import path from "node:path";

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts", ".json"];
const IMPORT_RE =
  /(?:\bimport|\bexport)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Files walked per route (graph size cap). */
const MAX_NODES = 3000;
/** Bytes read per file. */
const MAX_BYTES = 512 * 1024;

interface Alias {
  /** Text before `*` in the pattern (or the whole pattern when it has no `*`). */
  prefix: string;
  wildcard: boolean;
  /** Absolute targets with the `*` kept in place. */
  targets: string[];
}

/** Every module specifier in a source text. Exported for tests. */
export function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  for (let m = IMPORT_RE.exec(src); m; m = IMPORT_RE.exec(src)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) out.push(spec);
  }
  return out;
}

/** Lenient JSON for tsconfig: strips comments and trailing commas. */
function parseJsonc(text: string): any {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export class ImportGraph {
  private readonly parsed = new Map<string, { mtimeMs: number; deps: string[] }>();
  private aliases: Alias[] | null = null;
  private baseUrl: string | null = null;
  private configMtime = -1;

  constructor(private readonly root: string) {}

  /**
   * Route files (project-relative, from discovery) whose import closure contains any of `changed`
   * (project-relative, `/` or `\` separators). A route file that is itself changed is affected.
   */
  affected(routeFiles: readonly string[], changed: readonly string[]): Set<string> {
    const want = new Set(changed.map((f) => this.abs(f)));
    const out = new Set<string>();
    if (!want.size) return out;
    for (const rf of routeFiles) {
      if (this.reaches(this.abs(rf), want)) out.add(rf);
    }
    return out;
  }

  private abs(rel: string): string {
    return path.resolve(this.root, rel);
  }

  private reaches(start: string, want: Set<string>): boolean {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const f = stack.pop()!;
      if (want.has(f)) return true;
      if (seen.size > MAX_NODES) return false;
      for (const d of this.deps(f)) {
        if (want.has(d)) return true;
        if (!seen.has(d)) {
          seen.add(d);
          stack.push(d);
        }
      }
    }
    return false;
  }

  private deps(file: string): string[] {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.parsed.delete(file);
      return [];
    }
    const hit = this.parsed.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.deps;
    let deps: string[] = [];
    if (st.isFile() && st.size <= MAX_BYTES && !file.endsWith(".json")) {
      try {
        const src = fs.readFileSync(file, "utf8");
        const dir = path.dirname(file);
        const set = new Set<string>();
        for (const spec of importSpecifiers(src)) {
          const r = this.resolve(spec, dir);
          if (r) set.add(r);
        }
        deps = [...set];
      } catch {
        deps = [];
      }
    }
    this.parsed.set(file, { mtimeMs: st.mtimeMs, deps });
    return deps;
  }

  private resolve(spec: string, fromDir: string): string | null {
    if (spec.startsWith(".")) return this.probe(path.resolve(fromDir, spec));
    if (spec.startsWith("/")) return null;
    this.loadConfig();
    for (const a of this.aliases ?? []) {
      if (a.wildcard ? !spec.startsWith(a.prefix) : spec !== a.prefix) continue;
      const rest = a.wildcard ? spec.slice(a.prefix.length) : "";
      for (const t of a.targets) {
        const hit = this.probe(a.wildcard ? t.replace("*", rest) : t);
        if (hit) return hit;
      }
    }
    // `baseUrl` makes bare specifiers project-relative (`lib/db`). Only taken when the file exists,
    // so packages still resolve to nothing.
    if (this.baseUrl) {
      const hit = this.probe(path.resolve(this.baseUrl, spec));
      if (hit && !hit.includes(`${path.sep}node_modules${path.sep}`)) return hit;
    }
    return null;
  }

  /** `x` -> the existing file among x, x.ts, ..., x/index.ts, ...; strips a `.js` written for `.ts`. */
  private probe(base: string): string | null {
    const tries = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, `index${e}`))];
    const m = /\.([cm]?)js$/.exec(base);
    if (m) {
      const stem = base.slice(0, -m[0].length);
      tries.push(`${stem}.${m[1]}ts`, `${stem}.tsx`);
    }
    for (const t of tries) {
      try {
        if (fs.statSync(t).isFile()) return path.normalize(t);
      } catch {
        /* next */
      }
    }
    return null;
  }

  private loadConfig(): void {
    let file: string | undefined;
    let mtime = 0;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      try {
        const st = fs.statSync(path.join(this.root, name));
        file = path.join(this.root, name);
        mtime = st.mtimeMs;
        break;
      } catch {
        /* next */
      }
    }
    if (this.aliases && mtime === this.configMtime) return;
    this.configMtime = mtime;
    this.aliases = [];
    this.baseUrl = null;
    if (!file) return;
    try {
      const co = parseJsonc(fs.readFileSync(file, "utf8"))?.compilerOptions ?? {};
      const base = path.resolve(this.root, typeof co.baseUrl === "string" ? co.baseUrl : ".");
      if (typeof co.baseUrl === "string") this.baseUrl = base;
      for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
        if (!Array.isArray(targets)) continue;
        const star = pattern.indexOf("*");
        this.aliases.push({
          prefix: star >= 0 ? pattern.slice(0, star) : pattern,
          wildcard: star >= 0,
          targets: targets.filter((t): t is string => typeof t === "string").map((t) => path.resolve(base, t)),
        });
      }
      // Longest prefix first, like TypeScript.
      this.aliases.sort((a, b) => b.prefix.length - a.prefix.length);
    } catch {
      /* unparseable config: relative imports still work */
    }
  }
}
