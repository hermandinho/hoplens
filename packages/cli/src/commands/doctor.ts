import fs from "node:fs";
import path from "node:path";
import { loadTypeScript } from "@hoplens/transform/ts";
import { doctorExpress, doctorPath } from "../express/commands";
import { detectFramework, frameworkFlag } from "../framework";
import { nextFlagPath } from "../next/pathflag";
import { c, fail, ok, skip, warn } from "../style";
import { readJson, safeResolve } from "../util";

const CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"];
const INSTRUMENTATION_FILES = [
  "instrumentation.ts",
  "instrumentation.js",
  "instrumentation.mjs",
  "src/instrumentation.ts",
  "src/instrumentation.js",
  "src/instrumentation.mjs",
];
const MIN_NEXT_MAJOR = 15;
const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 9;

/**
 * Non-destructively verify Hoplens is wired correctly in the current project.
 * Groups output into Environment / Install / Wiring / Integrations. Exits
 * non-zero only when something critical is broken (missing runtime,
 * unconfigured next.config, missing instrumentation).
 *
 * ```bash
 * npx hoplens doctor
 * ```
 */
export async function doctor(args: string[]) {
  const root = process.cwd();
  console.log(`\n${c.magenta("◆ Hoplens")} doctor\n`);

  const state = { criticals: 0, warnings: 0 };
  const good = (s: string) => ok(s);
  const nope = (s: string, critical = false) => {
    if (critical) {
      state.criticals++;
      fail(s);
    } else {
      state.warnings++;
      warn(s);
    }
  };

  // ── Environment ─────────────────────────────────────────────────────────
  console.log(c.dim("  Environment"));
  const node = process.versions.node.split(".").map(Number);
  const nodeOk = node[0]! > MIN_NODE_MAJOR || (node[0] === MIN_NODE_MAJOR && node[1]! >= MIN_NODE_MINOR);
  nodeOk
    ? good(`Node.js ${process.versions.node}`)
    : nope(`Node.js ${process.versions.node} is below the required ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`, true);

  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) {
    nope("No package.json here — run doctor from your project root.", true);
    printSummary(state);
    return;
  }
  good(`Project ${c.bold(pkg.name ?? "(unnamed)")}`);

  loadTypeScript(root)
    ? good("TypeScript available (Zod pre-fill and function tracing on)")
    : skip("TypeScript not found — Zod pre-fill and tracing fall back to runtime-only");

  // A project with neither next nor express gets no framework checks: init can't wire it either.
  const flag = frameworkFlag(args);
  const fw = typeof flag === "object" ? flag : detectFramework(pkg, flag);
  if ("error" in fw) {
    nope(
      "neither" in fw && fw.neither
        ? `${fw.error} Hoplens supports Next.js (next) and Express (express); install one, or pass --framework next|express to check one anyway.`
        : fw.error,
      true,
    );
    printSummary(state);
    return;
  }
  if ("framework" in fw && fw.framework === "express") {
    doctorExpress(root, pkg, { good, nope });
    integrations(pkg);
    printSummary(state);
    return;
  }

  // ── Install ─────────────────────────────────────────────────────────────
  console.log(`\n${c.dim("  Install")}`);
  const nextPkg = readJson(safeResolve("next/package.json", root));
  if (!nextPkg) {
    nope("next is not installed", true);
  } else {
    const major = Number(
      String(nextPkg.version)
        .replace(/^[^\d]*/, "")
        .split(".")[0] ?? "0",
    );
    if (major >= MIN_NEXT_MAJOR) good(`Next.js ${nextPkg.version}`);
    else nope(`Next.js ${nextPkg.version} is below the recommended ${MIN_NEXT_MAJOR}.3`, false);
  }

  const hoplensInstalled =
    !!safeResolve("hoplens/package.json", root) || !!safeResolve("@hoplens/next/package.json", root);
  hoplensInstalled
    ? good("hoplens runtime is installed")
    : nope("hoplens runtime is not installed — run npm i -D hoplens", true);

  // ── Wiring ──────────────────────────────────────────────────────────────
  console.log(`\n${c.dim("  Wiring")}`);
  const cfg = CONFIG_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!cfg) nope("No next.config.* in this directory — run npx hoplens init", true);
  else {
    const src = fs.readFileSync(path.join(root, cfg), "utf8");
    src.includes("withHoplens")
      ? good(`${cfg} uses withHoplens`)
      : nope(`${cfg} doesn't wrap config in withHoplens — run npx hoplens init`, true);
  }

  const ins = INSTRUMENTATION_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!ins) nope("No instrumentation.* file — run npx hoplens init", true);
  else {
    const src = fs.readFileSync(path.join(root, ins), "utf8");
    // Accept both the modern hoplens/node form (0.1.2+) and the legacy
    // @hoplens/next/node form (0.1.0 / 0.1.1).
    if (!src.includes("hoplens/node") && !src.includes("@hoplens/next/node")) {
      nope(`${ins} doesn't load hoplens/node — run npx hoplens init`, true);
    } else {
      good(`${ins} loads the Hoplens runtime`);
      if (!src.includes('NODE_ENV === "development"') && !src.includes("NODE_ENV==='development'")) {
        nope('Hoplens isn\'t gated by NODE_ENV === "development" — it will attach in production too', false);
      }
    }
    const needsSrc = fs.existsSync(path.join(root, "src", "app")) || fs.existsSync(path.join(root, "src", "pages"));
    if (needsSrc && !ins.startsWith("src/")) {
      nope(`Your app is under src/ but instrumentation lives at the project root (${ins}) — move it to src/`, false);
    }
    if (!needsSrc && ins.startsWith("src/")) {
      nope(`Your app isn't under src/ but instrumentation is at ${ins} — move it to the project root`, false);
    }
  }

  // ── Request path ────────────────────────────────────────────────────────
  const devCmd = typeof pkg.scripts?.dev === "string" ? pkg.scripts.dev : null;
  doctorPath(devCmd ? { key: "dev", cmd: devCmd } : null, process.env, { nope }, nextFlagPath(root));

  integrations(pkg);

  printSummary(state);
}

/** The Integrations section, shared by the Next and Express checks. */
function integrations(pkg: any) {
  // ── Integrations ────────────────────────────────────────────────────────
  console.log(`\n${c.dim("  Integrations")}`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const otelPkgs = Object.keys(deps).filter((d) => d.startsWith("@opentelemetry/"));
  otelPkgs.length
    ? ok(
        `OpenTelemetry detected (${otelPkgs.length} package${otelPkgs.length === 1 ? "" : "s"}) — Hoplens will attach as a reader`,
      )
    : skip("OpenTelemetry not detected — Hoplens runs standalone");

  deps.zod
    ? ok(`Zod ${deps.zod} — RequestBuilder will pre-fill from your schemas`)
    : skip("Zod not detected — RequestBuilder won't pre-fill schema examples");

  const portEnv = process.env.HOPLENS_PORT;
  skip(
    portEnv ? `HOPLENS_PORT=${portEnv}` : "HOPLENS_PORT not set — the UI uses 4983, or the first free port up to 4993",
  );
}

function printSummary(state: { criticals: number; warnings: number }) {
  console.log("");
  if (state.criticals > 0) {
    fail(`${state.criticals} critical issue${state.criticals === 1 ? "" : "s"} — Hoplens won't start cleanly.`);
    if (state.warnings > 0) warn(`${state.warnings} warning${state.warnings === 1 ? "" : "s"} — see above.`);
    console.log("");
    return;
  }
  if (state.warnings > 0) {
    warn(`${state.warnings} warning${state.warnings === 1 ? "" : "s"} — Hoplens will run; review above.`);
    console.log("");
    return;
  }
  console.log(`  ${c.green("All set.")}\n`);
}
