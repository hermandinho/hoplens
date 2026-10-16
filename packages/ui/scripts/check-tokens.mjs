#!/usr/bin/env node
// Design-token guard (plan 3.10, WP0 acceptance). Pure Node, no deps. Exits 1 on any failure.
//
//  1. Hue separation: the bucket, severity and accent families never share a hue. Two chromatic
//     colors from different families must be >= MIN_HUE_GAP degrees apart (HSL hue). Neutrals
//     (chroma < NEUTRAL_CHROMA: slate handler, grey wait, info) carry no hue and are exempt.
//  2. Contrast: text tokens >= 4.5:1, chip/bar/edge tokens >= 3:1, on every surface in SURFACES.
//  3. Uppercase: text-transform: uppercase only on the section heads, never in a mono font.
//  4. Literals: no hex/rgb()/hsl() color outside tokens.css, and every var(--x) a sheet uses
//     is defined somewhere.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = process.env.CHECK_TOKENS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");
const MIN_HUE_GAP = 20;
const NEUTRAL_CHROMA = 0.18;

const FAMILIES = {
  bucket: ["--b-fn", "--b-db", "--b-ext", "--b-framework", "--b-cache", "--b-compile", "--b-idle"],
  severity: ["--err", "--warn", "--info", "--ok"],
  accent: ["--accent"],
};
const SURFACES = ["--bg", "--panel", "--panel-2"];
const TEXT = ["--fg", "--muted", "--dim", "--accent", "--err", "--warn", "--info", "--ok", "--b-compile"].concat([
  "--syn-key",
  "--syn-str",
  "--syn-num",
  "--syn-bool",
  "--diff-worse",
  "--diff-better",
]);
const EDGES = [...FAMILIES.bucket, ...FAMILIES.severity, ...FAMILIES.accent, "--diff-same"];
const PAIRS = [
  ["--accent-ink", "--accent", 4.5],
  ["--err", "--err-bg", 4.5],
  ["--bg", "--b-fn", 4.5], // dark ink on bucket-filled pills
];
const SECTION_HEADS = new Set([".section-head", ".section-title", ".insp-section-title", ".ov-section-title"]);

const failures = [];
const fail = (msg) => failures.push(msg);

const sheets = readdirSync(STYLES)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({
    name: f,
    css: readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")),
  }));
const tokensCss = sheets.find((s) => s.name === "tokens.css")?.css ?? "";

// ---- token table (first :root block of tokens.css is the default palette)
const rootBody = /:root\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
const raw = new Map();
for (const m of rootBody.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) raw.set(m[1], m[2].trim());

function resolve(name, seen = new Set()) {
  const v = raw.get(name);
  if (v === undefined) throw new Error(`token ${name} is not defined in tokens.css :root`);
  const alias = /^var\((--[\w-]+)\)$/.exec(v);
  if (alias) {
    if (seen.has(alias[1])) throw new Error(`alias cycle at ${name}`);
    seen.add(name);
    return resolve(alias[1], seen);
  }
  return v;
}

function hex(name) {
  const v = resolve(name);
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) throw new Error(`token ${name} must resolve to a hex color, got ${v}`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
}

function hueChroma([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c === 0) return { hue: 0, chroma: 0 };
  let h;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  return { hue: (h * 60 + 360) % 360, chroma: c };
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const report = [];

// ---- 1. hue separation
try {
  const entries = Object.entries(FAMILIES).flatMap(([fam, names]) =>
    names.map((n) => ({ fam, n, ...hueChroma(hex(n)) })),
  );
  const chromatic = entries.filter((e) => e.chroma >= NEUTRAL_CHROMA);
  for (const e of entries) {
    report.push(
      `hue  ${e.n.padEnd(15)} ${e.fam.padEnd(8)} ${e.chroma >= NEUTRAL_CHROMA ? `${e.hue.toFixed(0)}deg` : "neutral"}`,
    );
  }
  for (let i = 0; i < chromatic.length; i++) {
    for (let j = i + 1; j < chromatic.length; j++) {
      const a = chromatic[i];
      const b = chromatic[j];
      if (a.fam === b.fam) continue;
      const d = Math.min(Math.abs(a.hue - b.hue), 360 - Math.abs(a.hue - b.hue));
      if (d < MIN_HUE_GAP) fail(`hue: ${a.n} (${a.fam}) and ${b.n} (${b.fam}) are ${d.toFixed(1)}deg apart`);
    }
  }

  // ---- 2. contrast
  for (const s of SURFACES) {
    for (const t of TEXT) {
      const r = contrast(t, s);
      report.push(`text ${t.padEnd(15)} on ${s.padEnd(9)} ${r.toFixed(2)}`);
      if (r < 4.5) fail(`contrast: text ${t} on ${s} is ${r.toFixed(2)} (< 4.5)`);
    }
    for (const t of EDGES) {
      const r = contrast(t, s);
      if (r < 3) fail(`contrast: edge ${t} on ${s} is ${r.toFixed(2)} (< 3)`);
    }
  }
  for (const [a, b, min] of PAIRS) {
    const r = contrast(a, b);
    report.push(`pair ${a} on ${b} ${r.toFixed(2)}`);
    if (r < min) fail(`contrast: ${a} on ${b} is ${r.toFixed(2)} (< ${min})`);
  }
} catch (e) {
  fail(String(e.message ?? e));
}

// ---- 3. uppercase labels, 4. literal colors and undefined vars
const defined = new Set();
for (const s of sheets) for (const m of s.css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);

for (const s of sheets) {
  for (const m of s.css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    const body = m[2];
    if (/text-transform:\s*uppercase/.test(body)) {
      const sels = sel.split(",").map((x) => x.trim());
      if (!sels.every((x) => SECTION_HEADS.has(x))) fail(`uppercase: ${s.name} "${sel}" is not a section head`);
      if (/--font-mono/.test(body)) fail(`uppercase: ${s.name} "${sel}" is uppercase mono`);
    }
  }
  if (s.name !== "tokens.css") {
    for (const m of s.css.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi)) {
      const line = s.css.slice(0, m.index).split("\n").length;
      fail(`literal: ${s.name}:${line} uses ${m[0]} (use a token)`);
    }
  }
  for (const m of s.css.matchAll(/var\((--[\w-]+)\s*([,)])/g)) {
    if (!defined.has(m[1]) && m[2] === ")") fail(`var: ${s.name} uses undefined ${m[1]}`);
  }
}

if (process.argv.includes("--verbose")) console.log(report.join("\n"));
if (failures.length) {
  console.error(`check-tokens: ${failures.length} failure(s)\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `check-tokens: ok (${sheets.length} sheets, hue gap >= ${MIN_HUE_GAP}deg, contrast on ${SURFACES.join(" ")})`,
);
