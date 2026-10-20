// In-process dispatch checks, shared by dispatch4.test.ts and dispatch5.test.ts (one express major per
// file: the patches and their state are process-wide). Uses core's real tracer and processor through
// a fake Runtime, as core's own adapter-seam tests do.
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ROUTE_KEY, patchExpress, routesState, templateOf } from "../src/routes";
import type { ExpressAlias } from "./helpers";

const G = globalThis as any;
/** Added cost budget per traced request for template + handler hop (the M2 plan). */
const BUDGET_MS = 0.3;

export function dispatchSuite(alias: ExpressAlias): void {
  const express = require(alias);
  const major = Number.parseInt(require(`${alias}/package.json`).version, 10);
  const core = require("@hoplens/core") as typeof import("@hoplens/core");
  const store = new core.TraceStore(50);
  const rt: any = {
    options: { lateSpanGraceMs: 5, serverTiming: false },
    redactor: core.makeRedactor([]),
    store,
    root: process.cwd(),
    isStopped: false,
    routeInfo: () => undefined,
    proxyFile: () => undefined,
    currentTrace: core.Runtime.prototype.currentTrace,
    beginHop: core.Runtime.prototype.beginHop,
  };
  let route: any;
  /** An app created before the patches went in (its own use() and init are the originals). */
  let pre: any;
  const ctx = () => ({ trace: { spans: [] as any[], logs: [], done: false }, t0: Date.now() });
  const reqOf = () => ({ method: "GET", url: "/orders/9", baseUrl: "/api/users/7", params: {} }) as any;

  beforeAll(() => {
    core.installOtel(rt);
    pre = express();
    patchExpress(express, major);
    const app = express();
    const r = express.Router({ mergeParams: true });
    r.get("/orders/:id", (_req: any, _res: any, next: any) => next());
    app.use("/api/users/:uid", r);
    route = r.stack[0].route;
  });
  afterAll(() => {
    G.__hoplens_runtime = undefined;
  });

  describe(`${alias} dispatch (in process)`, () => {
    test("no runtime, or no trace: the original dispatch only (no hop, no template)", () => {
      G.__hoplens_runtime = undefined;
      const req = reqOf();
      let calls = 0;
      route.dispatch(req, new EventEmitter(), () => calls++);
      expect(calls).toBe(1);
      expect(req[ROUTE_KEY]).toBeUndefined();

      G.__hoplens_runtime = {
        isStopped: false,
        currentTrace: () => undefined,
        beginHop: () => {
          throw new Error("must not open a hop outside a trace");
        },
      };
      route.dispatch(req, new EventEmitter(), () => calls++);
      expect(calls).toBe(2);
      expect(req[ROUTE_KEY]).toBeUndefined();
    });

    test("in a trace: the full template, one handler hop, done() forwarded as given", () => {
      G.__hoplens_runtime = rt;
      const c = ctx();
      const req = reqOf();
      const res = new EventEmitter();
      const seen: unknown[][] = [];
      core.als.run(c as any, () =>
        route.dispatch(req, res, (...a: unknown[]) => {
          seen.push(a);
        }),
      );
      res.emit("finish");
      // Exactly what the original passes (Route's next calls done(err) with err undefined).
      G.__hoplens_runtime = undefined;
      const plain: unknown[][] = [];
      route.dispatch(reqOf(), new EventEmitter(), (...a: unknown[]) => {
        plain.push(a);
      });
      expect(seen).toEqual(plain);
      expect(seen[0]).toHaveLength(plain[0]!.length);
      // done() without an error hands the request on: the template is cleared for the next route.
      expect(req[ROUTE_KEY]).toBeUndefined();
      const hops = c.trace.spans.filter((s: any) => s.kind === "handler");
      expect(hops.map((s: any) => s.name)).toEqual(["GET /api/users/:uid/orders/:id"]);
    });

    const routerOf = (app: any) => (major >= 5 ? app.router : app._router);
    const st = () => routesState()!;
    const h = (_req: any, res: any) => res.end?.();

    test("the template walk never creates an app's router: settings made after it still apply", () => {
      const later = express();
      st().dirty = true;
      expect(templateOf(route, reqOf())).toBe("/api/users/:uid/orders/:id");
      later.set("case sensitive routing", true);
      later.set("strict routing", true);
      later.get("/Foo/", h);
      expect(routerOf(later).caseSensitive).toBe(true);
      expect(routerOf(later).strict).toBe(true);
      // A mounted sub-app configured after the walk, too.
      const sub = express();
      const parent = express();
      parent.use("/b", sub);
      st().dirty = true;
      templateOf(route, reqOf());
      sub.set("strict routing", true);
      sub.get("/Case/", h);
      expect(routerOf(sub).strict).toBe(true);
    });

    test("a sub-app mounted on an app made before the patches keeps its mount path", () => {
      const admin = express();
      admin.get("/stats/:id", h);
      pre.use("/admin", admin);
      const r = routerOf(admin).stack.at(-1).route;
      const req = { method: "GET", url: "/stats/1", baseUrl: "/admin", params: { id: "1" } };
      expect(templateOf(r, req)).toBe("/admin/stats/:id");
    });

    test("an untagged mount (made before the patches) does not leak its param values", () => {
      const r2 = express.Router({ mergeParams: true });
      r2.get("/orders/:id", h);
      const r = r2.stack[0].route;
      const req = (uid: string) => ({
        method: "GET",
        url: "/orders/9",
        baseUrl: `/t/acme/users/${uid}`,
        params: { tenant: "acme", id: "9" },
      });
      expect(templateOf(r, req("7"))).toBe("/t/:tenant/users/:id/orders/:id");
      expect(templateOf(r, req("8"))).toBe("/t/:tenant/users/:id/orders/:id");
    });

    test("a router built and registered per request does not force a rebuild", () => {
      templateOf(route, reqOf());
      expect(st().dirty).toBe(false);
      const d = express.Router();
      d.get("/:id", h);
      d.use((_req: any, _res: any, next: any) => next());
      expect(st().dirty).toBe(false);
      // Mounting it on a router the walk reached does.
      const app2 = express();
      templateOf(route, reqOf());
      app2.use("/d", d);
      expect(st().dirty).toBe(true);
      const dr = d.stack[0].route;
      expect(templateOf(dr, { method: "GET", url: "/1", baseUrl: "/d", params: {} })).toBe("/d/:id");
      // A route added to a reached router later.
      expect(st().dirty).toBe(false);
      d.get("/x/:y", h);
      expect(st().dirty).toBe(true);
    });

    test("more than 256 apps made after the main one do not evict it", () => {
      const many = Array.from({ length: 300 }, () => express());
      st().dirty = true;
      expect(templateOf(route, reqOf())).toBe("/api/users/:uid/orders/:id");
      expect(many).toHaveLength(300);
    });

    test("a route registered inside a request does not pin that request after formatting", async () => {
      v8.setFlagsFromString("--expose-gc");
      const gc = vm.runInNewContext("gc") as () => void;
      const keep: any[] = [];
      let ref!: WeakRef<object>;
      (() => {
        const reqLike = { payload: new Array(10000).fill(1) };
        ref = new WeakRef(reqLike);
        const r = express.Router();
        const inner = () => {
          if (reqLike.payload.length) r.get("/leak", h);
        };
        inner();
        keep.push(r);
      })();
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setImmediate(r));
        gc();
      }
      expect(keep[0].stack).toHaveLength(1);
      expect(ref.deref()).toBeUndefined();
    });

    if (major >= 5) {
      test("an Express 4 app from another copy, mounted in an Express 5 app, never breaks the walk", () => {
        const express4 = require("express4");
        const legacy = express4();
        legacy.get("/old", h);
        const app5 = express();
        app5.use("/legacy", legacy);
        const r3 = express.Router({ mergeParams: true });
        r3.get("/orders/:id", h);
        app5.use("/api/users/:uid", r3);
        st().dirty = true;
        expect(templateOf(r3.stack[0].route, reqOf())).toBe("/api/users/:uid/orders/:id");
        expect(templateOf(r3.stack[0].route, { ...reqOf(), baseUrl: "/api/users/8" })).toBe(
          "/api/users/:uid/orders/:id",
        );
      });
    }

    test(`added cost per traced dispatch < ${BUDGET_MS}ms`, () => {
      G.__hoplens_runtime = rt;
      const N = 2000;
      const batch = (traced: boolean) => {
        const c = ctx();
        const reqs = Array.from({ length: N }, reqOf);
        const ress = Array.from({ length: N }, () => new EventEmitter());
        const noop = () => {};
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          const go = () => route.dispatch(reqs[i], ress[i], noop);
          if (traced) core.als.run(c as any, go);
          else go();
          ress[i]!.emit("finish");
        }
        return (performance.now() - t0) / N;
      };
      for (let i = 0; i < 3; i++) {
        batch(true);
        batch(false);
      }
      const on: number[] = [];
      const off: number[] = [];
      for (let b = 0; b < 5; b++) {
        on.push(batch(true));
        off.push(batch(false));
      }
      const added = Math.min(...on) - Math.min(...off);
      // Reported in the test name's output on failure; logged for the M2 notes.
      console.log(
        `[${alias}] dispatch traced ${Math.min(...on).toFixed(4)}ms untraced ${Math.min(...off).toFixed(4)}ms`,
      );
      expect(added, `added ${added.toFixed(4)}ms`).toBeLessThan(BUDGET_MS);
    });
  });
}
