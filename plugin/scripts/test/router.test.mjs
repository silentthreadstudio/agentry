// Tests for lib/cli/router.mjs — the router `board.mjs` and `lane.mjs` share — on a throwaway subcommand
// directory, plus `lane.mjs` as a process. (`board.test.mjs` covers the router through `board.mjs`.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { route } from "../lib/cli/router.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = join(HERE, "..", "lane.mjs");

let tmp;
let dir;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "router-")));
  dir = join(tmp, "cli");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "echo.mjs"),
    `export const noSpec = true;
export const flags = { "--json": false, "--why": true };
export const usage = "echo [--json] [--why <x>]";
export const run = (argv, ctx) => ({ exit: 0, out: JSON.stringify({ argv, root: ctx.root }) });
`,
  );
  writeFileSync(
    join(dir, "needs-spec.mjs"),
    `export const run = (argv, ctx) => ({ exit: 0, out: "kinds:" + Object.keys(ctx.spec.kinds) });
`,
  );
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const go = (...argv) => route(argv, { dir, defaultSub: "echo" });

test("a no-spec sub runs with the resolved root and the default sub when none is named", async () => {
  const res = await go("--root", tmp);
  assert.equal(res.exit, 0);
  assert.equal(JSON.parse(res.out).root, tmp);
});

test("unknown sub is a usage error naming the known subs", async () => {
  const res = await go("nope");
  assert.equal(res.exit, 2);
  assert.match(res.out, /unknown subcommand "nope" \(subcommands: echo, needs-spec\)/);
});

test("no sub and no default is a usage error", async () => {
  const res = await route([], { dir });
  assert.equal(res.exit, 2);
  assert.match(res.out, /^no subcommand/);
});

test("a missing sub directory lists no subs rather than throwing", async () => {
  const res = await route(["x"], { dir: join(tmp, "absent") });
  assert.equal(res.exit, 2);
  assert.match(res.out, /\(subcommands: \)/);
});

test("unknown flag is a usage error with the sub's usage line", async () => {
  const res = await go("echo", "--bogus");
  assert.equal(res.exit, 2);
  assert.match(res.out, /unknown option "--bogus"\nusage: echo \[--json\]/);
});

test("--flag=value reads as --flag value; a value on a boolean flag is refused", async () => {
  const ok = await go("echo", "--why=because");
  assert.deepEqual(JSON.parse(ok.out).argv, ["--why", "because"]);
  const bad = await go("echo", "--json=1");
  assert.equal(bad.exit, 2);
  assert.match(bad.out, /--json takes no value/);
});

test("--root without a value is refused", async () => {
  const res = await go("echo", "--root");
  assert.equal(res.exit, 2);
  assert.match(res.out, /--root needs a value/);
});

test("a sub that needs the spec is refused on a broken process file", async () => {
  const file = join(tmp, "process.json");
  writeFileSync(file, '{"kinds":{}}');
  const res = await go("needs-spec", "--root", tmp, "--process", file);
  assert.equal(res.exit, 2);
  assert.match(res.out, /cannot use the process file\n {2}the process file is missing "version"/);
});

test("a missing process file is refused with the init hint", async () => {
  const res = await go("needs-spec", "--root", tmp, "--process", join(tmp, "absent.json"));
  assert.equal(res.exit, 2);
  assert.match(res.out, /run \/agentry:init/);
});

test("lane.mjs with no subs yet answers a usage error, exit 2", () => {
  const res = spawnSync("node", [LANE, "anything"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown subcommand "anything"/);
});
