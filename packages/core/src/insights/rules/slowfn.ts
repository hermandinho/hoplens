import type { Finding } from "../../types";
import { type Rule, fingerprint, roundMs } from "../context";

/** A traced function whose own (self) time is large in absolute terms or relative to the request. */
export const slowFn: Rule = (ctx) => {
  const out: Finding[] = [];
  const { th, duration } = ctx;
  for (const s of ctx.spans) {
    if (s.kind !== "function") continue;
    const self = ctx.self.get(s.id) ?? 0;
    const share = duration > 0 ? self / duration : 0;
    const slow =
      self >= th.slowFnMs ||
      (duration >= th.slowFnMinTraceMs && self >= th.slowFnShareMinMs && share >= th.slowFnShare);
    if (!slow) continue;
    const f: Finding = {
      rule: "slow-fn",
      severity: self >= th.slowFnMs * 5 ? "error" : "warn",
      title: `${s.name} spent ${roundMs(self)}ms in its own code (${Math.round(share * 100)}% of the request)`,
      detail:
        "Self time excludes traced child calls. It can be CPU work or awaits on something Hoplens doesn't instrument.",
      fingerprint: fingerprint("slow-fn", ctx.routeKey, s.name),
      spanIds: [s.id],
      fn: s.name,
    };
    if (s.location) f.location = s.location;
    out.push(f);
  }
  return out;
};
