import { afterEach, describe, expect, test, vi } from "vitest";
import { HoplensApiError, api } from "../src/api/client";
import type { Meta, PathMeta } from "../src/api/types";
import {
  PATH_COST_NOTE,
  PATH_RESTART_NOTE,
  envFootText,
  offView,
  pathSwitch,
  pathSwitchJob,
  setPathEnabled,
  switchErrorText,
} from "../src/state/path";
import { metaState } from "../src/state/store";

/*
 * The request path's sticky switch (Express): which control each meta.path state shows, the off
 * state's copy per source, and the POST round trip that sets `pending` without waiting for a reload.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/path-switch.test.ts
 */

const meta = (path: PathMeta): Pick<Meta, "path" | "framework" | "root"> => ({ root: "/app", path });

describe("pathSwitch", () => {
  test("one control per state", () => {
    expect(pathSwitch(meta({ state: "off", source: "default" }), false)).toEqual({ kind: "enable" });
    expect(pathSwitch(meta({ state: "off", source: "default", pending: "on" }), false)).toEqual({
      kind: "pending-on",
    });
    expect(pathSwitch(meta({ state: "on", source: "flag" }), false)).toEqual({ kind: "disable" });
    expect(pathSwitch(meta({ state: "on", source: "flag", pending: "off" }), false)).toEqual({ kind: "pending-off" });
    expect(pathSwitch(meta({ state: "on", source: "env" }), false)).toEqual({ kind: "env" });
    expect(pathSwitch(meta({ state: "off", source: "env" }), false)).toEqual({ kind: "env" });
    // Flag on but c8 owns coverage: the switch can still turn it off.
    expect(pathSwitch(meta({ state: "disabled-c8", source: "flag" }), false)).toEqual({ kind: "disable" });
  });

  test("no switch on Next, on an older core, or without meta", () => {
    expect(pathSwitch(meta({ state: "off", source: "default" }), true)).toBeNull();
    expect(pathSwitch(meta({ state: "off" }), false)).toBeNull();
    expect(pathSwitch(null, false)).toBeNull();
  });

  test("copy", () => {
    expect(PATH_COST_NOTE).toBe("block coverage from start; CPU-heavy code runs slower");
    expect(PATH_RESTART_NOTE).toBe("Restart your dev server to apply (saving a file restarts node --watch)");
  });
});

describe("offView per source", () => {
  test("default: enable here or the env var, command kept as the secondary option", () => {
    const v = offView(
      meta({ state: "off", source: "default", reason: "enable it here, or restart with HOPLENS_PATH=1" }),
      false,
    )!;
    expect(v.title).toBe("Request path is off");
    expect(v.body).toContain("enable it here");
    expect(v.body).toContain("HOPLENS_PATH=1");
    expect(v.command).toBe("export HOPLENS_PATH=1");
  });

  test("env: set by HOPLENS_PATH, no switch", () => {
    const v = offView(meta({ state: "off", source: "env", reason: "HOPLENS_PATH=0 turns it off" }), false)!;
    expect(v.title).toContain("set by HOPLENS_PATH");
    expect(v.body).toContain("HOPLENS_PATH=0 turns it off");
    expect(v.body).toContain("always wins");
  });

  test("default with pending on: says it is on at next start, not 'enable it here'", () => {
    const v = offView(meta({ state: "off", source: "default", pending: "on" }), false)!;
    expect(v.title).toBe("Request path: on at next start");
    expect(v.body).not.toContain("enable it here");
    expect(v.body).toContain("next start");
  });

  test("env off: the copyable command unsets HOPLENS_PATH and the note names the dev script", () => {
    const posix = offView(meta({ state: "off", source: "env", reason: "HOPLENS_PATH=0 turns it off" }), false)!;
    expect(posix.command).toBe("unset HOPLENS_PATH");
    expect(posix.commandNote).toContain("dev script");
    const win = offView(
      { root: "D:\\app", path: { state: "off", source: "env", reason: "HOPLENS_PATH=0 turns it off" } },
      false,
    )!;
    expect(win.command).toBe("Remove-Item Env:HOPLENS_PATH");
  });

  test("flag without the register hook: says why it did not start", () => {
    const v = offView(meta({ state: "off", source: "flag", reason: "load the register hook" }), false)!;
    expect(v.title).toContain("did not start");
    expect(v.command).toBeUndefined();
  });

  test("on via flag or env: no off view", () => {
    expect(offView(meta({ state: "on", source: "flag" }), false)).toBeNull();
    expect(offView(meta({ state: "on", source: "env" }), false)).toBeNull();
  });
});

describe("envFootText", () => {
  test("says on when HOPLENS_PATH turned it on, like the banner and doctor", () => {
    expect(envFootText("on")).toBe("Request path: on (set by HOPLENS_PATH)");
    expect(envFootText("disabled-c8")).toBe("Request path: set by HOPLENS_PATH");
  });
});

describe("setPathEnabled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    metaState.value = null;
    pathSwitchJob.value = { busy: false };
  });

  test("enable: POSTs, then meta.path shows pending on at once", async () => {
    metaState.value = { root: "/app", path: { state: "off", source: "default" } } as Meta;
    const spy = vi
      .spyOn(api, "pathSwitch")
      .mockResolvedValue({ path: { state: "off", source: "default", pending: "on" } });
    expect(await setPathEnabled(true)).toBe(true);
    expect(spy).toHaveBeenCalledWith(true);
    expect(metaState.value?.path).toEqual({ state: "off", source: "default", pending: "on" });
    expect(metaState.value?.root).toBe("/app");
    expect(pathSwitch(metaState.value, false)).toEqual({ kind: "pending-on" });
    expect(pathSwitchJob.value).toEqual({ busy: false });
  });

  test("disable on via flag: pending off", async () => {
    metaState.value = { root: "/app", path: { state: "on", source: "flag" } } as Meta;
    vi.spyOn(api, "pathSwitch").mockResolvedValue({ path: { state: "on", source: "flag", pending: "off" } });
    await setPathEnabled(false);
    expect(pathSwitch(metaState.value, false)).toEqual({ kind: "pending-off" });
  });

  test("a refusal keeps meta and shows the server's sentence", async () => {
    const before = { root: "/app", path: { state: "off", source: "env" } } as Meta;
    metaState.value = before;
    vi.spyOn(api, "pathSwitch").mockRejectedValue(
      new HoplensApiError(
        409,
        JSON.stringify({ code: "env", error: "HOPLENS_PATH=0 is set ... always wins" }),
        "/path/enable",
      ),
    );
    expect(await setPathEnabled(true)).toBe(false);
    expect(metaState.value).toBe(before);
    expect(pathSwitchJob.value.error).toContain("always wins");
  });

  test("one call at a time", async () => {
    let release!: () => void;
    const spy = vi.spyOn(api, "pathSwitch").mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({ path: { state: "off", source: "default", pending: "on" } });
        }),
    );
    const first = setPathEnabled(true);
    expect(await setPathEnabled(true)).toBe(false);
    release();
    await first;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("error text: body sentence, 404 (older core), network", () => {
    expect(switchErrorText(new HoplensApiError(500, '{"error":"EACCES"}', "/x"))).toBe("EACCES");
    expect(switchErrorText(new HoplensApiError(404, "nope", "/x"))).toContain("no request path switch");
    expect(switchErrorText(new TypeError("Failed to fetch"))).toContain("Failed to fetch");
  });
});
