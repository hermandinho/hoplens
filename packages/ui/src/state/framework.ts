import type { FindingRule, Meta } from "../api/types";
import { RULE_LABELS } from "./stats";

/*
 * Which framework the UI is looking at, and the copy that depends on it. Next.js keeps every
 * sentence it always had; another framework (Express today) gets wording without `next dev`,
 * dev compiles or Next's data cache: there, "cold" means the first request after the app started or
 * restarted, and an edit is a restart whose sources changed (core epochs mode "restart"). Pure: the live form is `frameworkCopy` in state/store.
 * Tested by packages/ui/test/framework.test.ts.
 */

/** Display names of the frameworks Hoplens has an adapter for. Others are capitalised as reported. */
const NAMES: Record<string, string> = { next: "Next.js", express: "Express", nest: "NestJS", fastify: "Fastify" };

/** The framework's id, lower-cased. A core that predates `meta.framework` only ever ran under Next. */
export function frameworkId(meta: Pick<Meta, "framework"> | null | undefined): string {
  const name = meta?.framework?.name?.trim().toLowerCase();
  return name || "next";
}

export function isNextApp(meta: Pick<Meta, "framework"> | null | undefined): boolean {
  return frameworkId(meta) === "next";
}

/** "Next.js", "Express", ... (Next.js while meta is unknown). */
export function frameworkLabel(meta: Pick<Meta, "framework"> | null | undefined): string {
  const id = frameworkId(meta);
  const known = NAMES[id];
  if (known) return known;
  const raw = meta?.framework?.name?.trim() ?? id;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * The top-bar pill: "Express 5.3.0", "Next 16.0.1" (Next keeps its short name). From
 * `meta.framework`, else the older `meta.next`; null when no version is known for Next, and the bare
 * name for another framework without one.
 */
export function frameworkPill(meta: Pick<Meta, "framework" | "next"> | null | undefined): string | null {
  if (!meta) return null;
  if (isNextApp(meta)) {
    const v = meta.framework?.version ?? meta.next;
    return v ? `Next ${v}` : null;
  }
  const v = meta.framework?.version;
  return v ? `${frameworkLabel(meta)} ${v}` : frameworkLabel(meta);
}

export interface FrameworkCopy {
  isNext: boolean;
  /** "Next.js", "Express". */
  label: string;
  /** The folded band of framework spans in the waterfall / flame. */
  band: string;
  /** Its kind chip. */
  bandChip: string;
  /** What the band folds, for its tooltip. */
  bandParts: string;
  /** Time-budget bar hint for the framework bucket. */
  frameworkHint: string;
  /** Time-budget bar hint for the compile bucket. */
  compileHint: string;
  /** Verdict wording for the dominant bucket (framework, compile). */
  frameworkWords: string;
  compileWords: string;
  /** The wait before the handler ran, for the wait segment's hint. */
  waitHint: string;
  /** Why a request was cold, as a tag / clause: "likely dev compile". */
  coldTag: string;
  /** "Cold: first request after a rebuild" (no compile time measured). */
  coldPlain: string;
  /** The untraced stretch of a cold wait. */
  coldGap: string;
  /** RULE_LABELS["cold-compile"]. */
  coldRule: string;
  /** The finding-sentence clause for cold-compile: "the dev compile ran first". */
  coldClause: string;
  /** Overview: the Cold toggle's tooltip. */
  coldToggleHint: string;
  /** Overview: the low-signal findings ("seen once or caused by the dev compile"). */
  lowSignal: string;
  /** Overview: the low-signal list's heading. */
  lowSignalHead: string;
  /** Overview: the cold tag's tooltip. */
  coldTagHint: string;
  /** Health strip: what else blocks the loop. */
  loopBlockedHint: string;
  /** The fetch cache a GET can ask for (Queries hosts, fetch-uncached sentence). */
  dataCache: string;
  /** One dev epoch, for tooltips: "dev-rebuild epoch" / "dev epoch (a new one when a restart changed code)". */
  epoch: string;
  /** What the epoch rail ticks are: "Edits (dev rebuilds)" / "Edits (app restarts that changed code)". */
  edits: string;
  /** The Changes tab's tooltip. */
  changesTitle: string;
  /** Changes with no edit yet (Next keeps its own sentence, with markup, in ChangesView). */
  changesEmpty: string;
  /** The generated vitest file: what has to be running for it. */
  runWith: string;
  /** The generated vitest file: which requests the time budget skips. */
  coldSkipped: string;
  /** The query bar's `cold:true` hint. */
  coldQueryHint: string;
}

export const NEXT_COPY: FrameworkCopy = {
  isNext: true,
  label: "Next.js",
  band: "Next.js",
  bandChip: "NEXT",
  bandParts: "request, routing, compile, render, response",
  frameworkHint: "Next.js internals: routing, rendering, response",
  compileHint: "Dev compile and module loading",
  frameworkWords: "Next.js internals",
  compileWords: "dev compile",
  waitHint: "Time before your route handler started: dev compile, proxy and routing",
  coldTag: "likely dev compile",
  coldPlain: "Cold: first request after a rebuild",
  coldGap: "Next loading instrumentation / compiling (untraced)",
  coldRule: RULE_LABELS["cold-compile"],
  coldClause: "the dev compile ran first",
  coldToggleHint:
    "Cold = first request after a rebuild, or one that waited on a dev compile. Excluded from percentiles by default.",
  lowSignal: "seen once or caused by the dev compile",
  lowSignalHead: "Seen once, dev compile or gone since an edit",
  coldTagHint: "Time the dev server spent compiling: not something the code saves",
  loopBlockedHint:
    "The event loop was blocked: requests handled meanwhile waited. Look for sync work (big JSON, sync fs, crypto) or a dev compile.",
  dataCache: "Next's data cache",
  epoch: "dev-rebuild epoch",
  edits: "Edits (dev rebuilds)",
  changesTitle: "Your edits (dev rebuilds) and what each one changed",
  changesEmpty:
    "No edits yet. Save a source file while next dev runs and send a request: each rebuild shows up here with the files it changed and how each affected route moved.",
  runWith: "Run it with `next dev` (and Hoplens) up.",
  coldSkipped: "Cold (compiling) requests are skipped.",
  coldQueryHint: "first request after a rebuild",
};

const RESTART = "first request after start/restart";

/** The copy for a framework that is not Next.js: no dev compile, a restart is what makes it cold. */
export function otherCopy(label: string): FrameworkCopy {
  return {
    isNext: false,
    label,
    band: label,
    bandChip: "FW",
    bandParts: "request, routing, response",
    frameworkHint: `${label} internals: routing, response`,
    compileHint: `Module loading on the ${RESTART}`,
    frameworkWords: `${label} internals`,
    compileWords: "module loading after a restart",
    waitHint: "Time before your route handler started: routing and middleware",
    coldTag: RESTART,
    coldPlain: `Cold: ${RESTART}`,
    coldGap: `loading modules on the ${RESTART} (untraced)`,
    coldRule: "cold start",
    coldClause: `it was the ${RESTART}`,
    coldToggleHint: `Cold = the ${RESTART} on each route. Excluded from percentiles by default.`,
    lowSignal: `seen once or on the ${RESTART}`,
    lowSignalHead: "Seen once, cold start or gone since an edit",
    coldTagHint: `The ${RESTART} pays for loading modules: not something the code saves`,
    loopBlockedHint:
      "The event loop was blocked: requests handled meanwhile waited. Look for sync work (big JSON, sync fs, crypto).",
    dataCache: "a fetch cache",
    epoch: "dev epoch (a new one when a restart changed code)",
    edits: "Edits (app restarts that changed code)",
    changesTitle: "Your edits (each restart that changed code) and what each one changed",
    changesEmpty:
      "No edits yet. Save a file: node --watch restarts the app and the edit shows up here, with the files it changed and how each affected route moved.",
    runWith: "Run it with the app (and Hoplens) running.",
    coldSkipped: `Cold requests (the ${RESTART}) are skipped.`,
    coldQueryHint: RESTART,
  };
}

export function frameworkCopyOf(meta: Pick<Meta, "framework"> | null | undefined): FrameworkCopy {
  return isNextApp(meta) ? NEXT_COPY : otherCopy(frameworkLabel(meta));
}

/** RULE_LABELS with the cold-compile label following the framework. */
export function ruleLabel(rule: FindingRule | string, fw: FrameworkCopy = NEXT_COPY): string {
  if (rule === "cold-compile") return fw.coldRule;
  return RULE_LABELS[rule as FindingRule] ?? rule;
}

/**
 * A finding title as core wrote it ("... since the last rebuild"), reworded for a framework whose
 * epochs are processes rather than rebuilds. Next titles pass through.
 */
export function findingTitle(title: string, fw: FrameworkCopy = NEXT_COPY): string {
  if (fw.isNext) return title;
  return title.replace(/since the last rebuild/, "since the app started");
}
