import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test } from "vitest";
import { installOtel } from "../src/capture";
import type { Runtime } from "../src/runtime";

function fakeRuntime(): Runtime {
  return { root: process.cwd() } as unknown as Runtime;
}

describe("installOtel", () => {
  afterEach(() => {
    // Reset the global OTel state between tests.
    trace.disable();
    context.disable();
  });

  test("own: no provider registered → installs its own and returns 'own'", () => {
    expect(installOtel(fakeRuntime())).toBe("own");
    const provider = trace.getTracerProvider();
    expect(provider).toBeDefined();
  });

  test("attached: existing BasicTracerProvider with _spanProcessors array → push onto it", () => {
    const existing = new BasicTracerProvider({ spanProcessors: [] });
    trace.setGlobalTracerProvider(existing);

    const before = (existing as any)._activeSpanProcessor?._spanProcessors?.length ?? 0;
    const result = installOtel(fakeRuntime());

    expect(result).toBe("attached");
    const multi = (existing as any)._activeSpanProcessor ?? (existing as any).activeSpanProcessor;
    expect(multi, "existing provider should expose a composite span processor").toBeDefined();
    expect(Array.isArray(multi._spanProcessors), "composite processor should hold an array").toBe(true);
    expect(multi._spanProcessors.length).toBe(before + 1);
  });

  test("attached: provider exposing addSpanProcessor() → call it", () => {
    const added: unknown[] = [];
    const fake = {
      getTracer: () => ({
        startSpan: () => ({ end: () => {} }),
        startActiveSpan: (_n: unknown, _o: unknown, cb: (s: any) => any) => cb({ end: () => {} }),
      }),
      addSpanProcessor: (p: unknown) => added.push(p),
    };
    trace.setGlobalTracerProvider(fake as any);

    expect(installOtel(fakeRuntime())).toBe("attached");
    expect(added.length).toBe(1);
  });

  test("none: provider has neither _spanProcessors nor addSpanProcessor → return 'none'", () => {
    const inertProvider = {
      getTracer: () => ({
        startSpan: () => ({ end: () => {} }),
        startActiveSpan: (_n: unknown, _o: unknown, cb: (s: any) => any) => cb({ end: () => {} }),
      }),
    };
    trace.setGlobalTracerProvider(inertProvider as any);

    expect(installOtel(fakeRuntime())).toBe("none");
  });

  test("spans flow through the attached processor", async () => {
    const captured: string[] = [];
    const existing = new BasicTracerProvider({
      spanProcessors: [
        {
          onStart() {},
          onEnd(span) {
            captured.push(span.name);
          },
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        },
      ],
    });
    trace.setGlobalTracerProvider(existing);
    installOtel(fakeRuntime());

    const tracer = trace.getTracer("test");
    tracer.startSpan("test.span").end();

    // Give the pipeline a tick to drain.
    await new Promise((r) => setTimeout(r, 10));
    expect(captured).toContain("test.span");
  });
});
