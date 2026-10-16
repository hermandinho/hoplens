import type { Finding } from "../../types";
import { type Rule, fingerprint, roundMs } from "../context";

/** The request paid for a dev compile / first-hit module load. The UI leaves these out of baselines. */
export const coldCompile: Rule = (ctx) => {
  const { facts, th } = ctx;
  const heavy = facts.compileMs >= th.coldCompileMs;
  if (!heavy && !facts.cold) return [];
  const f: Finding = {
    rule: "cold-compile",
    severity: "info",
    title: heavy
      ? `Cold request: ${roundMs(facts.compileMs)}ms spent compiling/loading the route`
      : "Cold request: first hit on this route since the last rebuild",
    detail: "Dev-only cost. Don't judge this route's speed by it.",
    fingerprint: fingerprint("cold-compile", ctx.routeKey, ""),
    spanIds: ctx.spans.filter((s) => s.kind === "compile").map((s) => s.id),
  };
  if (heavy) f.estSavedMs = roundMs(facts.compileMs);
  return [f];
};
