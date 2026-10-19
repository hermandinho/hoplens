// GET /api/source carries the whole file's sha1/12, the same hash a path trace records per function
// (capture.ts sourceText): the UI's Source view compares the two before laying counts over the lines.
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sendJson } from "../src/api/module";
import type { Runtime } from "../src/runtime";
import { handleUi } from "../src/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-src-"));
const file = path.join(dir, "a.js");
const text = "function a() {\n  return 1;\n}\n";
fs.writeFileSync(file, text);
const rt = { options: {}, resolveFile: (f: string) => (f === "a.js" ? file : null) } as unknown as Runtime;
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    handleUi(rt, req, res).catch((err) => sendJson(res, 500, { error: String(err) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__hoplens`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the source endpoint returns the file's current sha1/12 with its lines", async () => {
  const res = await fetch(`${base}/api/source?file=a.js&line=1&context=0`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { lines: string[]; hash: string };
  expect(body.lines).toEqual(["function a() {"]);
  expect(body.hash).toBe(createHash("sha1").update(text).digest("hex").slice(0, 12));
});
