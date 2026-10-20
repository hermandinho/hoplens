import { describe, expect, test } from "vitest";
import { tokenize, unwireScript, wireScript } from "../src/express/script";
import { deleteFrom, findJsonString, insertInto } from "../src/json-edit";

const F = "--import hoplens/express/register";

function wired(cmd: string): string {
  const r = wireScript(cmd);
  if (r.kind !== "wired") throw new Error(`expected wired, got ${JSON.stringify(r)}`);
  return r.out;
}

function roundTrip(cmd: string) {
  const out = wired(cmd);
  const range = unwireScript(out)!;
  expect(range).not.toBeNull();
  expect(out.slice(0, range.from) + out.slice(range.to)).toBe(cmd);
}

describe("wireScript", () => {
  const cases: [string, string][] = [
    ["node src/server.js", `node ${F} src/server.js`],
    ["node --watch src/server.js", `node --watch ${F} src/server.js`],
    ["node --watch src/server.mjs", `node --watch ${F} src/server.mjs`],
    ["node --env-file=.env --inspect src/server.js", `node ${F} --env-file=.env --inspect src/server.js`],
    ["node -r dotenv/config src/server.js", `node ${F} -r dotenv/config src/server.js`],
    ["tsx watch src/server.ts", `tsx watch ${F} src/server.ts`],
    ["tsx src/server.ts", `tsx ${F} src/server.ts`],
    ["npx tsx watch src/server.ts", `npx tsx watch ${F} src/server.ts`],
    [
      "cross-env NODE_ENV=development node --watch src/server.js",
      `cross-env NODE_ENV=development node --watch ${F} src/server.js`,
    ],
    ["NODE_ENV=development PORT=4000 node src/server.js", `NODE_ENV=development PORT=4000 node ${F} src/server.js`],
    ["tsc -p . && node dist/server.js", `tsc -p . && node ${F} dist/server.js`],
    ["node scripts/seed.js && node --watch src/server.js", `node scripts/seed.js && node --watch ${F} src/server.js`],
    ["nodemon src/server.js", `nodemon --exec "node ${F}" src/server.js`],
    ["nodemon --watch src src/server.js", `nodemon --exec "node ${F}" --watch src src/server.js`],
    ['nodemon --exec "node --inspect" src/server.js', `nodemon --exec "node ${F} --inspect" src/server.js`],
    ["nodemon -x 'tsx' src/server.ts", `nodemon -x 'tsx ${F}' src/server.ts`],
    ['node "src/my server.js"', `node ${F} "src/my server.js"`],
  ];
  for (const [input, output] of cases) {
    test(`${input}`, () => {
      expect(wired(input)).toBe(output);
      roundTrip(input);
    });
  }

  test("already wired, any form", () => {
    for (const cmd of [
      `node --watch ${F} src/server.js`,
      "node -r hoplens/express/register src/server.js",
      "node --require @hoplens/express/register src/server.js",
      "node --import=hoplens/express/register src/server.js",
      "NODE_OPTIONS='--import hoplens/express/register' node src/server.js",
    ])
      expect(wireScript(cmd).kind).toBe("already");
  });

  test("runners left for the user, with the line to use", () => {
    expect(wireScript("ts-node-dev --respawn src/server.ts")).toMatchObject({
      kind: "manual",
      script: "ts-node-dev -r hoplens/express/register --respawn src/server.ts",
    });
    expect(wireScript("ts-node src/server.ts")).toMatchObject({
      kind: "manual",
      script: "ts-node -r hoplens/express/register src/server.ts",
    });
    expect(wireScript("pm2 start src/server.js --watch")).toMatchObject({
      kind: "manual",
      script: `pm2 start src/server.js --watch --node-args="${F}"`,
    });
    for (const cmd of [
      "bun --watch src/server.ts",
      "docker compose up",
      "nodemon src/server.ts",
      "nodemon --exec ts-node src/server.ts",
      "npm run build && npm run serve",
      "vite",
    ])
      expect(wireScript(cmd).kind, cmd).toBe("manual");
  });

  test("nodemon running TypeScript is left for the user, wherever the entry sits", () => {
    for (const cmd of [
      "nodemon --watch src -e ts src/index.ts",
      "nodemon -w src --ext ts,json src/index.ts",
      "nodemon --watch src --ext ts",
    ])
      expect(wireScript(cmd), cmd).toMatchObject({ kind: "manual" });
    expect(wired("nodemon --watch src -e js,json src/index.js")).toBe(
      `nodemon --exec "node ${F}" --watch src -e js,json src/index.js`,
    );
  });

  test("pipes and background jobs: the producer, or the user when it's ambiguous", () => {
    expect(wired("node --watch src/x.js | node scripts/pretty.js")).toBe(
      `node --watch ${F} src/x.js | node scripts/pretty.js`,
    );
    roundTrip("node --watch src/x.js | node scripts/pretty.js");
    expect(wired("node --watch src/x.js | pino-pretty")).toBe(`node --watch ${F} src/x.js | pino-pretty`);
    expect(wired("tsc -w & node --watch dist/x.js")).toBe(`tsc -w & node --watch ${F} dist/x.js`);
    expect(wired("node a.js | node b.js && node --watch c.js")).toBe(`node a.js | node b.js && node --watch ${F} c.js`);
    expect(wireScript("node --watch src/x.js & node worker.js").kind).toBe("manual");
    expect(wireScript("node a.js & node b.js | node c.js").kind).toBe("manual");
  });

  test("nodemon --config file: its exec could be anything, so the user decides", () => {
    for (const cmd of [
      "nodemon --config nodemon.dev.json src/index.js",
      "nodemon -c nodemon.dev.json src/index.js",
      "nodemon --config=nodemon.dev.json src/index.js",
    ])
      expect(wireScript(cmd), cmd).toMatchObject({ kind: "manual" });
  });

  test("nodemon config exec wins over node", () => {
    expect(wireScript("nodemon src/server.js", { nodemonExec: "ts-node" }).kind).toBe("manual");
  });
});

describe("unwireScript", () => {
  test('a hand-written --exec "node" would read back as init\'s own form, so init leaves it to the user', () => {
    for (const cmd of ['nodemon --exec "node" src/server.js', 'nodemon --watch src --exec "node" src/server.js'])
      expect(wireScript(cmd), cmd).toMatchObject({
        kind: "manual",
        hint: expect.stringContaining(`--exec "node ${F}"`),
      });
    roundTrip('nodemon -x "node" src/server.js');
    roundTrip("nodemon --exec 'node' src/server.js");
  });

  test("only init's text", () => {
    expect(unwireScript("node -r hoplens/express/register src/server.js")).toBeNull();
    expect(unwireScript(`node ${F}-extra src/server.js`)).toBeNull();
  });
});

describe("tokenize", () => {
  test("splits chains, keeps quoted words whole", () => {
    const segs = tokenize(`a "b c" && d 'e' | f; g`);
    expect(segs.map((s) => s.words.map((w) => w.text))).toEqual([["a", "b c"], ["d", "e"], ["f"], ["g"]]);
  });
});

describe("json-edit", () => {
  test("finds a nested string and edits only its bytes (escapes, CRLF, 4 spaces)", () => {
    const src =
      '{\r\n    "name": "x",\r\n    "scripts": {\r\n        "dev": "nodemon --exec \\"node --inspect\\" a.js"\r\n    }\r\n}\r\n';
    const span = findJsonString(src, ["scripts", "dev"])!;
    expect(span.value).toBe('nodemon --exec "node --inspect" a.js');
    const r = wireScript(span.value);
    if (r.kind !== "wired") throw new Error("expected wired");
    const out = insertInto(src, span, r.at, r.text);
    expect(JSON.parse(out).scripts.dev).toBe(`nodemon --exec "node ${F} --inspect" a.js`);
    expect(out.replace(` ${F}`, "")).toBe(src);
    const span2 = findJsonString(out, ["scripts", "dev"])!;
    const range = unwireScript(span2.value)!;
    expect(deleteFrom(out, span2, range.from, range.to)).toBe(src);
  });

  test("a scripts key nested deeper is not the top-level one", () => {
    const src = '{"workspaces": {"scripts": {"dev": "no"}}, "scripts": {"build": "tsc"}}';
    expect(findJsonString(src, ["scripts", "dev"])).toBeNull();
    expect(findJsonString(src, ["scripts", "build"])?.value).toBe("tsc");
  });
});
