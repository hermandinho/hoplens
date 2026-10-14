// Source-map resolution for both bundler shapes Next uses in dev:
//   - Turbopack ships sectioned maps alongside .js files — `node:module.SourceMap` handles them.
//   - Webpack `eval-source-map` embeds a base64 map inside each eval'd module, keyed by a
//     `webpack-internal:///…` sourceURL. We scan `<distDir>/{dev,}/server` for these inline maps.

import fs from "node:fs";
import path from "node:path";
import { SourceMap } from "node:module";
import { fileURLToPath } from "node:url";
import type { SourceLocation } from "./types";

interface Frame {
  fn?: string;
  file: string;
  line: number;
  column: number;
  // Generated code was in node_modules even if the map points elsewhere.
  foreign?: boolean;
}

const maps = new Map<string, { mtimeMs: number; map: SourceMap | null }>();
const existsCache = new Map<string, boolean>();
function exists(p: string) {
  let v = existsCache.get(p);
  if (v === undefined) {
    v = fs.existsSync(p);
    existsCache.set(p, v);
    if (existsCache.size > 2000) existsCache.clear();
  }
  return v;
}

function loadMap(file: string): SourceMap | null {
  const mapFile = file + ".map";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(mapFile);
  } catch {
    return null;
  }
  const hit = maps.get(mapFile);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.map;
  let map: SourceMap | null = null;
  try {
    map = new SourceMap(JSON.parse(fs.readFileSync(mapFile, "utf8")));
  } catch {
    map = null;
  }
  maps.set(mapFile, { mtimeMs: stat.mtimeMs, map });
  if (maps.size > 400) maps.delete(maps.keys().next().value!);
  return map;
}

/* webpack dev (eval-source-map): each module is eval'd with an inline map and a webpack-internal:/// URL. */
const evalMaps = new Map<string, SourceMap | null>();
const scanned = new Map<string, number>(); // bundle file -> mtime
let distDirs: string[] = [];

export function setDistDir(root: string, distDir = ".next") {
  const base = path.join(root, distDir);
  distDirs = [path.join(base, "dev", "server"), path.join(base, "server")];
}

function* jsFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p, depth + 1);
    else if (e.name.endsWith(".js")) yield p;
  }
}

const EVAL_MAP_RE =
  /sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)\\n\/\/# sourceURL=(webpack-internal:\/\/\/[^\\"]+)/g;

let lastScan = 0;
function evalMap(url: string): SourceMap | null {
  if (Date.now() - lastScan > 500) {
    lastScan = Date.now();
    scanBundles();
  }
  return evalMaps.get(url) ?? null;
}

function scanBundles() {
  for (const dir of distDirs) {
    for (const file of jsFiles(dir)) {
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (scanned.get(file) === mtime) continue;
      scanned.set(file, mtime);
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes("webpack-internal:///")) continue;
      for (const m of text.matchAll(EVAL_MAP_RE)) {
        const b64 = m[1]!;
        const url = m[2]!;
        try {
          evalMaps.set(url, new SourceMap(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))));
        } catch {
          evalMaps.set(url, null);
        }
      }
    }
  }
}

/** Forget cached eval maps (called when a module recompiles and its URL now points at new code). */
export function resetEvalMaps() {
  evalMaps.clear();
  scanned.clear();
}

/** Turns a bundler source path (file://, turbopack://[project]/, webpack://app/./) into an absolute path. */
export function normalizeSource(src: string, root: string, mapDir?: string): string {
  if (src.startsWith("file://")) return fileURLToPath(src);
  const project = src.match(/^turbopack:\/\/\/\[project\]\/(.*)$/);
  if (project) return path.join(root, project[1]!);
  const webpack = src.match(/^webpack(?:-internal)?:\/\/\/?(?:\([^)]*\)\/)?(?:[^/]*\/)?\.\/(.*)$/);
  if (webpack) return path.join(root, webpack[1]!);
  if (path.isAbsolute(src)) return src;
  return mapDir ? path.resolve(mapDir, src) : path.join(root, src);
}

export function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const m = line.match(/^at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    frames.push({ fn: m[1], file: m[2]!, line: Number(m[3]), column: Number(m[4]) });
  }
  return frames;
}

export function mapFrame(frame: Frame, root: string): Frame {
  let file = frame.file;
  if (file.startsWith("file://")) file = fileURLToPath(file);
  if (file.startsWith("webpack-internal:")) {
    const map = evalMap(file);
    const entry: any = map?.findEntry(frame.line - 1, frame.column - 1);
    if (entry?.originalSource) {
      const original = normalizeSource(entry.originalSource, root);
      return {
        fn: entry.name ?? frame.fn,
        file: original,
        line: entry.originalLine + 1,
        column: entry.originalColumn + 1,
        foreign: original.includes(`${path.sep}node_modules${path.sep}`) || !exists(original),
      };
    }
    const out = normalizeSource(file, root);
    return { ...frame, file: out, foreign: out.includes(`${path.sep}node_modules${path.sep}`) };
  }
  if (file.startsWith("turbopack:")) {
    const out = normalizeSource(file, root);
    return { ...frame, file: out, foreign: out.includes(`${path.sep}node_modules${path.sep}`) };
  }
  if (!path.isAbsolute(file)) return { ...frame, foreign: true };
  const foreign = file.includes(`${path.sep}node_modules${path.sep}`);
  const map = loadMap(file);
  if (!map) return { ...frame, file, foreign };
  const entry: any = map.findEntry(frame.line - 1, frame.column - 1);
  if (!entry || !entry.originalSource) return { ...frame, file, foreign };
  const original = normalizeSource(entry.originalSource, root, path.dirname(file));
  const realFile = exists(original);
  // Framework maps point at sources that aren't on disk; keep the shipped file so the path stays honest.
  if (foreign && !realFile) return { ...frame, file, foreign: true };
  return {
    fn: entry.name ?? frame.fn,
    file: original,
    line: entry.originalLine + 1,
    column: entry.originalColumn + 1,
    foreign: foreign || original.includes(`${path.sep}node_modules${path.sep}`) || !realFile,
  };
}

export function isProjectFile(file: string, root: string, foreign = false): boolean {
  if (foreign || !file.startsWith(root)) return false;
  const rel = file.slice(root.length);
  return !/[\\/](node_modules|\.next)[\\/]/.test(rel);
}

export function relative(file: string, root: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Maps a stack through source maps; returns the readable stack and the first frame in the user's code. */
export function mapStack(stack: string, root: string, skip = 0): { stack: string; location?: SourceLocation } {
  const head = stack.split("\n").filter((l) => !l.trim().startsWith("at "))[0] ?? "";
  const frames = parseStack(stack).slice(skip).map((f) => mapFrame(f, root));
  let location: SourceLocation | undefined;
  const lines: string[] = [];
  let framework = 0;
  let hidden = 0;
  for (const f of frames) {
    const own = isProjectFile(f.file, root, f.foreign);
    if (own && !location) location = { file: relative(f.file, root), line: f.line, column: f.column };
    if (!own && ++framework > 3) {
      hidden++;
      continue;
    }
    const where = own ? `${relative(f.file, root)}:${f.line}:${f.column}` : shorten(f.file, root) + `:${f.line}`;
    lines.push(`    at ${f.fn ? f.fn + " " : ""}(${where})${own ? "" : "  [framework]"}`);
  }
  if (hidden) lines.push(`    … ${hidden} more framework frames`);
  return { stack: [head, ...lines].join("\n"), location };
}

function shorten(file: string, root: string): string {
  const nm = file.lastIndexOf("node_modules/");
  if (nm >= 0) return file.slice(nm + 13);
  const next = file.indexOf("/next/");
  if (next >= 0) return "next" + file.slice(next + 5);
  if (file.startsWith(root)) return relative(file, root);
  return file;
}

/** Location of whoever called the function that called this (used for console calls). */
export function callerLocation(root: string, skip: number): SourceLocation | undefined {
  const stack = new Error().stack ?? "";
  for (const f of parseStack(stack).slice(skip, skip + 8)) {
    const m = mapFrame(f, root);
    if (isProjectFile(m.file, root, m.foreign)) return { file: relative(m.file, root), line: m.line, column: m.column };
  }
  return undefined;
}
