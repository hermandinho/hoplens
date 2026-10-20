// The request path's sticky switch for adapters that decide with core loaded (Next: path/flag.ts):
// HOPLENS_PATH wins, else <stateDir>/path.json, else off; enable/disable write and remove the flag,
// and `pending` compares the file with this start's decision.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { pathMeta } from "../src/path/capture";
import { PATH_FLAG_FILE, envPathSetting, flagPathControl, readPathFlagFile, writePathFlagFile } from "../src/path/flag";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-flag-"));
  dirs.push(d);
  return path.join(d, "cache", "hoplens");
};

describe("flagPathControl", () => {
  test("off by default; Enable writes the flag and is pending until the next start", () => {
    const dir = tmp();
    const { on, control } = flagPathControl(dir, {});
    expect(on).toBe(false);
    expect(control.source).toBe("default");
    expect(control.pending()).toBeUndefined();
    control.enable();
    expect(readPathFlagFile(dir)).toMatchObject({ enabled: true, by: "ui" });
    expect(control.pending()).toBe("on");
    expect(pathMeta(undefined, {}, control)).toMatchObject({ state: "off", source: "default", pending: "on" });
    // The next start reads it.
    const next = flagPathControl(dir, {});
    expect(next).toMatchObject({ on: true });
    expect(next.control.source).toBe("flag");
    next.control.disable();
    expect(fs.existsSync(path.join(dir, PATH_FLAG_FILE))).toBe(false);
    expect(next.control.pending()).toBe("off");
  });

  test("HOPLENS_PATH wins over the flag, both ways, and nothing is pending", () => {
    const dir = tmp();
    writePathFlagFile(dir, "init");
    expect(flagPathControl(dir, { HOPLENS_PATH: "0" })).toMatchObject({ on: false });
    const env = flagPathControl(dir, { HOPLENS_PATH: "1" });
    expect(env.on).toBe(true);
    expect(env.control.source).toBe("env");
    expect(env.control.pending()).toBeUndefined();
    expect(envPathSetting({ HOPLENS_PATH: " true " })).toBe(true);
    expect(envPathSetting({ HOPLENS_PATH: "" })).toBeUndefined();
  });

  test("a corrupt flag is off", () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PATH_FLAG_FILE), "{nope");
    expect(flagPathControl(dir, {}).on).toBe(false);
    fs.writeFileSync(path.join(dir, PATH_FLAG_FILE), '{"enabled":"yes"}');
    expect(flagPathControl(dir, {}).on).toBe(false);
  });
});
