// Gate, one-shot boot and the singleton, in real child processes running the built register hook.
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ESM_INDEX,
  type Fixture,
  INDEX,
  REGISTER,
  bannerCount,
  childEnv,
  freePort,
  isListening,
  makeFixture,
  run,
} from "./helpers";

/** Child-side probe: is any @hoplens/core module loaded? (pnpm links it to packages/core) */
const CORE_LOADED = String.raw`Object.keys(require.cache).some((k) => /[\\/]core[\\/]dist[\\/]|@hoplens[\\/]core/.test(k))`;

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture(undefined, {
    // Two servers, so a second listen must not boot again.
    "two-servers.cjs": `
      const http = require("node:http");
      const before = !!globalThis.__hoplens_runtime;
      const a = http.createServer((q, s) => s.end("a"));
      a.listen(0, "127.0.0.1");
      const bootedSync = !!globalThis.__hoplens_runtime;
      const rt = globalThis.__hoplens_runtime;
      a.once("listening", () => {
        const b = http.createServer((q, s) => s.end("b"));
        b.listen(0, "127.0.0.1", () => {
          setTimeout(() => {
            console.log(JSON.stringify({ result: { before, bootedSync, same: rt === globalThis.__hoplens_runtime,
              uiPort: rt && rt.uiPort, appPort: rt && rt.appPort, aPort: a.address().port } }));
            a.close(); b.close();
          }, 300);
        });
      });
    `,
    // The app asks for the UI's own port: the UI must step aside, not take it first.
    "collide.cjs": `
      const http = require("node:http");
      const want = Number(process.env.HOPLENS_PORT);
      const s = http.createServer((q, r) => r.end("app"));
      s.on("error", (e) => console.log(JSON.stringify({ result: { error: e.code } })));
      s.listen(want, "127.0.0.1", () => {
        const rt = globalThis.__hoplens_runtime;
        // The UI binds asynchronously, and waits ~1s (samePortRetryMs) when its next port is busy
        // too: poll for it rather than reading it after a fixed delay.
        const t0 = Date.now();
        const check = () => {
          if (rt && rt.uiPort === undefined && Date.now() - t0 < 4000) return setTimeout(check, 50);
          http.get({ host: "127.0.0.1", port: want, path: "/" }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => {
              console.log(JSON.stringify({ result: { bound: s.address().port, body, uiPort: rt && rt.uiPort } }));
              s.close();
            });
          });
        };
        setTimeout(check, 50);
      });
    `,
    // hoplens() from code, no register hook, then the app takes the UI's port.
    "collide-code.cjs": `
      require(${JSON.stringify(INDEX)}).hoplens();
      require("./collide.cjs");
    `,
    // hoplens() called only once the app already listens: no listen left to hook.
    "late-call.cjs": `
      const http = require("node:http");
      const s = http.createServer((q, r) => r.end("ok"));
      s.listen(0, "127.0.0.1", () => {
        require(${JSON.stringify(INDEX)}).hoplens();
        setTimeout(() => {
          console.log(JSON.stringify({ result: { booted: !!globalThis.__hoplens_runtime } }));
          s.close();
        }, 600);
      });
    `,
    "gate-off.cjs": `
      const http = require("node:http");
      const s = http.createServer((q, r) => r.end("ok"));
      s.listen(0, "127.0.0.1", () => {
        console.log(JSON.stringify({ result: { core: ${CORE_LOADED}, runtime: !!globalThis.__hoplens_runtime } }));
        s.close();
      });
    `,
    "never-listens.cjs": `
      setTimeout(() => {
        console.log(JSON.stringify({ result: { core: ${CORE_LOADED}, runtime: !!globalThis.__hoplens_runtime } }));
      }, 400);
    `,
    "with-hoplens.cjs": `
      const http = require("node:http");
      const { hoplens } = require(${JSON.stringify(INDEX)});
      const rt1 = hoplens({}, {});
      const rt2 = hoplens();
      const s = http.createServer((q, r) => r.end("ok"));
      s.listen(0, "127.0.0.1", () => setTimeout(() => {
        // Before the listen nothing has booted yet; after it, one runtime.
        console.log(JSON.stringify({ result: { early: !!rt1 || !!rt2, booted: !!globalThis.__hoplens_runtime } }));
        s.close();
      }, 300));
    `,
    "esm-same.mjs": `
      import { createRequire } from "node:module";
      import * as esm from ${JSON.stringify(pathToFileURL(ESM_INDEX).href)};
      const require = createRequire(import.meta.url);
      const cjs = require(${JSON.stringify(INDEX)});
      console.log(JSON.stringify({ result: { same: esm.hoplens === cjs.hoplens && esm.default === cjs.hoplens,
        type: typeof esm.hoplens } }));
    `,
  });
});
afterAll(() => fx.cleanup());

async function result(args: string[], env: Record<string, string | undefined> = {}) {
  const port = await freePort();
  const child = run(args, fx.root, childEnv({ HOPLENS_PORT: String(port), ...env }));
  try {
    const { result } = await child.waitFor("result");
    return { result, port, stdout: child.stdout(), stderr: child.stderr(), child };
  } finally {
    await child.kill();
  }
}

describe("gate off: nothing loads", () => {
  test.each([
    ["-r", { NODE_ENV: "production" }],
    ["--import", { NODE_ENV: "production" }],
    ["-r", { NODE_ENV: "test" }],
    ["-r", { HOPLENS: "0" }],
  ])("%s with %j: no @hoplens/core in require.cache, no runtime, the app still listens", async (flag, env) => {
    const r = await result([flag, flag === "--import" ? pathToFileURL(REGISTER).href : REGISTER, "gate-off.cjs"], env);
    expect(r.result).toEqual({ core: false, runtime: false });
    expect(bannerCount(r.stdout)).toBe(0);
    expect(await isListening(r.port)).toBe(false);
  });

  test("HOPLENS_FORCE=1 turns it back on under NODE_ENV=production", async () => {
    const r = await result(["-r", REGISTER, "gate-off.cjs"], { NODE_ENV: "production", HOPLENS_FORCE: "1" });
    expect(r.result).toEqual({ core: true, runtime: true });
  });
});

describe("boot", () => {
  test("a process that never listens loads no core and binds no UI port", async () => {
    const r = await result(["-r", REGISTER, "never-listens.cjs"]);
    expect(r.result).toEqual({ core: false, runtime: false });
    expect(await isListening(r.port)).toBe(false);
  });

  test("boots on the first listen, before the original listen runs, and only once (register loaded twice)", async () => {
    const r = await result(["-r", REGISTER, "--import", pathToFileURL(REGISTER).href, "two-servers.cjs"]);
    expect(r.result.before).toBe(false);
    expect(r.result.bootedSync).toBe(true);
    expect(r.result.same).toBe(true);
    expect(r.result.uiPort).toBe(r.port);
    // The first app server's real port, not the second one's or process.env.PORT.
    expect(r.result.appPort).toBe(r.result.aPort);
    expect(bannerCount(r.stdout)).toBe(1);
    expect(r.stdout).toContain(`http://localhost:${r.result.aPort}/__hoplens`);
    expect(r.stdout).toContain(`http://127.0.0.1:${r.port}`);
    expect(r.stdout).toContain("Could not resolve express");
    expect(r.stderr).not.toContain("hoplens:express");
  });

  test("an app listening on the UI port keeps it; the UI moves above it", async () => {
    const r = await result(["-r", REGISTER, "collide.cjs"]);
    expect(r.result).toMatchObject({ bound: r.port, body: "app" });
    expect(r.result.uiPort).toBeGreaterThan(r.port);
    expect(r.stderr).not.toContain("hoplens:express");
  });

  test("hoplens(app) from code: an app listening on the UI port keeps it too", async () => {
    const r = await result(["collide-code.cjs"]);
    expect(r.result).toMatchObject({ bound: r.port, body: "app" });
    expect(r.result.uiPort).toBeGreaterThan(r.port);
    expect(r.stderr).not.toContain("hoplens:express");
  });

  test("hoplens(app) called after the app already listens still boots", async () => {
    const r = await result(["late-call.cjs"], { HOPLENS_LATE_BOOT_MS: "100" });
    expect(r.result).toEqual({ booted: true });
    expect(bannerCount(r.stdout)).toBe(1);
  });

  test("register + hoplens(app) boots once", async () => {
    const r = await result(["-r", REGISTER, "with-hoplens.cjs"]);
    expect(r.result).toEqual({ early: false, booted: true });
    expect(bannerCount(r.stdout)).toBe(1);
  });

  test("hoplens(app) returns undefined with the gate off", async () => {
    const r = await result(["with-hoplens.cjs"], { NODE_ENV: "production" });
    expect(r.result).toEqual({ early: false, booted: false });
    expect(bannerCount(r.stdout)).toBe(0);
    expect(await isListening(r.port)).toBe(false);
  });

  test("the ESM entry re-exports the CJS build (one instance)", async () => {
    const r = await result(["esm-same.mjs"]);
    expect(r.result).toEqual({ same: true, type: "function" });
  });
});
