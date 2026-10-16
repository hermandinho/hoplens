import type { Finding } from "../../types";
import { type Rule, fingerprint } from "../context";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/** Request or response body over `largePayloadBytes`. */
export const largePayload: Rule = (ctx) => {
  const { facts, th } = ctx;
  const out: Finding[] = [];
  if (facts.resBytes > th.largePayloadBytes)
    out.push({
      rule: "large-payload",
      severity: "warn",
      title: `Response body is ${mb(facts.resBytes)}`,
      detail: "Paginate, select fewer fields, or stream it.",
      fingerprint: fingerprint("large-payload", ctx.routeKey, "res"),
      spanIds: [],
    });
  if (facts.reqBytes > th.largePayloadBytes)
    out.push({
      rule: "large-payload",
      severity: "warn",
      title: `Request body is ${mb(facts.reqBytes)}`,
      detail: "Large uploads are usually better sent straight to storage with a signed URL.",
      fingerprint: fingerprint("large-payload", ctx.routeKey, "req"),
      spanIds: [],
    });
  return out;
};
