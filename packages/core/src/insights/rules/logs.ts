import type { Finding } from "../../types";
import { type Rule, fingerprint } from "../context";

/** console.warn / console.error during a request that still succeeded. */
export const logsOnSuccess: Rule = (ctx) => {
  const status = ctx.trace.status;
  if (status === undefined || status >= 400) return [];
  const noisy = ctx.trace.logs.filter((l) => l.level === "warn" || l.level === "error");
  if (noisy.length === 0) return [];
  const errors = noisy.filter((l) => l.level === "error").length;
  const warns = noisy.length - errors;
  const parts = [errors ? `${errors} error` : "", warns ? `${warns} warn` : ""].filter(Boolean).join(" + ");
  const first = noisy.find((l) => l.level === "error") ?? noisy[0]!;
  const span = first.spanId ? ctx.byId.get(first.spanId) : undefined;
  const owner = span ? ctx.owner(span) : {};
  const line = first.text.split("\n")[0] ?? "";
  const f: Finding = {
    rule: "logs-on-success",
    severity: errors ? "warn" : "info",
    title: `${parts} log${noisy.length > 1 ? "s" : ""} on a ${status}: ${line.length > 60 ? `${line.slice(0, 59)}…` : line}`,
    fingerprint: fingerprint(
      "logs-on-success",
      ctx.routeKey,
      first.location ? `${first.location.file}:${first.location.line}` : line.slice(0, 80),
    ),
    spanIds: span ? [span.id] : [],
    count: noisy.length,
  };
  if (owner.fn) f.fn = owner.fn;
  const loc = first.location ?? owner.location;
  if (loc) f.location = loc;
  return [f];
};
