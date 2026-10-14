import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NextDiscoverySource } from "../src/routes";

const ROUTES = 500;
let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-bench-"));
  for (let i = 0; i < ROUTES; i++) {
    const seg = i % 5 === 0 ? `/[id${i}]` : "";
    const dir = path.join(tmp, "src", "app", "api", `r${Math.floor(i / 25)}`, `handler${i}${seg.replace(/[[\]]/g, "")}`);
    fs.mkdirSync(dir, { recursive: true });
    const schemas = i % 3 === 0 ? `const Q = z.object({ a: z.string(), b: z.number().int().min(1) });\n` : "";
    const uses = i % 3 === 0 ? `  Q.parse(await req.json());\n` : "";
    fs.writeFileSync(
      path.join(dir, "route.ts"),
      `import { z } from "zod";
${schemas}export async function GET(req: Request) {
${uses}  return Response.json({ i: ${i} });
}
`,
    );
  }
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe(`${ROUTES}-route benchmark`, () => {
  test("cold scan under 1.5s, warm scan under 300ms", () => {
    const src = new NextDiscoverySource(tmp, "");

    const t0 = performance.now();
    const cold = src.scan();
    const coldMs = performance.now() - t0;

    const t1 = performance.now();
    const warm = src.scan();
    const warmMs = performance.now() - t1;

    expect(cold.routes.length).toBe(ROUTES);
    expect(warm.routes.length).toBe(ROUTES);

    // Log the numbers so the CI output shows them.
    // eslint-disable-next-line no-console
    console.log(`bench: ${ROUTES} routes · cold=${coldMs.toFixed(0)}ms warm=${warmMs.toFixed(0)}ms`);

    // Budget references the Runtime's 1500ms discovery throttle. Warm is loosened from the
    // original 100ms target to 300ms to cover Windows FS walk overhead for 500 nested dirs.
    expect(coldMs, "cold scan must stay under 1.5s").toBeLessThan(1500);
    expect(warmMs, "warm scan must stay under 300ms (well under the 1500ms throttle)").toBeLessThan(300);
  });
});
