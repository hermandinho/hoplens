// Manual trace helpers for code the auto-tracer can't reach (class methods, default exports,
// inline callbacks). When the runtime isn't loaded (prod, edge, browser) these call fn directly.

/**
 * Wrap a function so it shows up as a hop in the request journey. Returns the function unchanged
 * when the runtime isn't active, so it's safe to leave in production code.
 *
 * ```ts
 * import { traced } from "@hoplens/core/trace";
 *
 * export const charge = traced("stripe.charge", (amount: number) =>
 *   stripe.charges.create({ amount }),
 * );
 * ```
 */
export function traced<F extends (...args: any[]) => any>(name: string, fn: F): F {
  const tp = (globalThis as any).__hoplens;
  if (!tp || typeof tp.wrap !== "function") return fn;
  return tp.wrap(fn, { name, file: callerFile(), line: 0 });
}

/**
 * Run `fn` inside a named step of the current request's journey. Executes `fn` directly when
 * the runtime isn't active.
 *
 * ```ts
 * import { step } from "@hoplens/core/trace";
 *
 * await step("send welcome email", () => mailer.send(user));
 * ```
 */
export function step<T>(name: string, fn: () => T): T {
  const tp = (globalThis as any).__hoplens;
  if (!tp || typeof tp.wrap !== "function") return fn();
  return tp.wrap(fn, { name, file: callerFile(), line: 0 })();
}

function callerFile(): string {
  const line = new Error().stack?.split("\n")[3] ?? "";
  const m = line.match(/\(?([^()\s]+):(\d+):\d+\)?$/);
  return m ? `${m[1]}:${m[2]}` : "";
}

/**
 * Drop-in logger for Drizzle so queries show up as `db` spans. Drizzle's
 * built-in logger only fires once per query (no duration), so the span is a
 * zero-length marker — but you get the SQL + bound params in the journey.
 * For real timing, let the underlying driver (`pg`, etc.) be instrumented —
 * Hoplens patches `pg` automatically.
 *
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { drizzleLogger } from "@hoplens/core/trace";
 *
 * const db = drizzle(client, { logger: drizzleLogger() });
 * ```
 */
export function drizzleLogger() {
  return {
    logQuery(query: string, params: unknown[]) {
      const tp = (globalThis as any).__hoplens;
      if (!tp || typeof tp.emitDb !== "function") return;
      tp.emitDb({ system: "sql", query, params, name: "drizzle.query" });
    },
  };
}
