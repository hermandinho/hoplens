// makeWrap inside a request must behave like the unwrapped function: an argument it cannot preview,
// a getter on an argument, a promise the app decorated, and a hot helper called in a loop.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { context, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MAX_FN_SPANS_PER_TRACE, als, droppedFunctionSpans, installOtel, makeWrap } from "../src/capture";
import type { Runtime } from "../src/runtime";
import { makeRedactor, preview } from "../src/serialize";
import { makeTrace } from "./helpers";

const root = path.resolve(__dirname, "..");
const META = { name: "f", file: "src/f.ts", line: 3 };

let wrap: ReturnType<typeof makeWrap>;

beforeEach(() => {
  const rt = { root, redactor: makeRedactor([]), store: { get: () => undefined } } as unknown as Runtime;
  installOtel(rt);
  wrap = makeWrap(rt);
});
afterEach(() => {
  trace.disable();
  context.disable();
});

function inRequest<T>(fn: () => T): { out: T; t: ReturnType<typeof makeTrace> } {
  const t = makeTrace([], { duration: 100 });
  const out = als.run({ trace: t, t0: performance.timeOrigin }, fn);
  return { out, t };
}

describe("arguments the preview cannot read", () => {
  const touch = (x: unknown) => typeof x;

  test("a revoked Proxy argument does not make the call throw", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const { out, t } = inRequest(() => wrap(touch, META)(proxy));
    expect(out).toBe("object");
    expect(t.spans.filter((s) => s.kind === "function")).toHaveLength(1);
  });

  test("a Proxy whose traps throw does not make the call throw, and its traps never run", () => {
    let trapped = 0;
    const p = new Proxy(
      {},
      {
        ownKeys() {
          trapped++;
          throw new Error("no keys");
        },
        get() {
          trapped++;
          throw new Error("no get");
        },
        getPrototypeOf() {
          trapped++;
          throw new Error("no proto");
        },
      },
    );
    const { out } = inRequest(() => wrap(touch, META)(p));
    expect(out).toBe("object");
    expect(trapped).toBe(0);
  });

  test("an own getter on an argument is not called", () => {
    let n = 0;
    const o = {
      a: 1,
      get v() {
        n++;
        return 1;
      },
    };
    const { t } = inRequest(() => wrap((_o: unknown) => 1, META)(o));
    expect(n).toBe(0);
    expect(t.spans[0]!.args).toEqual([{ a: 1, v: "[Getter]" }]);
  });

  test("preview never throws and never calls getters", () => {
    const r = makeRedactor([]);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    let n = 0;
    expect(preview(proxy, r)).toBe("[Proxy]");
    expect(
      preview(
        {
          get g() {
            n++;
            return 1;
          },
          nested: [proxy],
        },
        r,
      ),
    ).toEqual({ g: "[Getter]", nested: ["[Proxy]"] });
    expect(n).toBe(0);
  });
});

describe("returned promises", () => {
  test("a promise the function decorated comes back as the same object", async () => {
    const cancellable = () => {
      const p: Promise<number> & { cancel?: () => string } = new Promise((r) => setTimeout(() => r(2), 2));
      p.cancel = () => "cancelled";
      return p;
    };
    const { out, t } = inRequest(() => wrap(cancellable, META)());
    expect(typeof out.cancel).toBe("function");
    expect(await out).toBe(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.spans[0]!.result).toBe(2);
  });

  test("a decorated promise that rejects still rejects for the caller, and the span is failed", async () => {
    const fails = () => {
      const p: Promise<never> & { tag?: number } = Promise.reject(new Error("nope"));
      p.tag = 1;
      return p;
    };
    const { out, t } = inRequest(() => wrap(fails, META)());
    expect(out.tag).toBe(1);
    await expect(out).rejects.toThrow("nope");
    await new Promise((r) => setTimeout(r, 2));
    expect(t.spans[0]!.error?.message).toBe("nope");
  });

  test("a plain promise (Node's own async_hooks symbols on it are not the app's) is chained", async () => {
    let made: Promise<number> | undefined;
    const { out } = inRequest(() =>
      wrap(() => {
        made = Promise.resolve(1);
        return made;
      }, META)(),
    );
    // Chained, so an un-awaited rejection still surfaces as unhandled, as it does without Hoplens.
    expect(out).not.toBe(made);
    expect(await out).toBe(1);
  });

  test("a plain promise still resolves to the value and records the result", async () => {
    const { out, t } = inRequest(() => wrap(async () => 5, META)());
    expect(await out).toBe(5);
    expect(t.spans[0]!.result).toBe(5);
  });
});

describe("function spans per trace", () => {
  test(`a hot helper opens at most ${"MAX_FN_SPANS_PER_TRACE"} spans and counts the rest as dropped`, () => {
    const hot = wrap((a: number) => a + 1, META);
    const N = MAX_FN_SPANS_PER_TRACE + 500;
    const { out, t } = inRequest(() => {
      let s = 0;
      for (let i = 0; i < N; i++) s += hot(i);
      return s;
    });
    expect(out).toBe((N * (N - 1)) / 2 + N);
    expect(t.spans.filter((s) => s.kind === "function")).toHaveLength(MAX_FN_SPANS_PER_TRACE);
    expect(droppedFunctionSpans(t)).toBe(500);
  });
});
