// Tests for the board tools end to end and for the plugin's registration surface: setup registers
// `agentry_board` + `agentry_board_write` through a captured fake ctx (the real host's shape is
// duck-typed; the fake proves ours provably works), reads return the board's own lines, and a write
// previews and writes nothing unless `--apply` traveled in `words` — while an unknown option
// surfaces the CLI's own refusal verbatim. Offline, against temp synthetic boards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Plugin } from "../index.js";
import { boardRead, boardWrite } from "../src/tools/board.mjs";
import { fixtureCleanup, mkBoard, snapshot } from "./fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAY = await import(new URL("../vendor/scripts/lib/cli/help.mjs", import.meta.url));

after(fixtureCleanup);

test("setup registers exactly the board pair through the editor, namespaced, typed reads", async () => {
  const added = [];
  await Plugin.setup({ tool: { transform: { editor: { add: (tool) => added.push(tool) } } } });
  assert.deepEqual(
    added.map(({ name }) => name),
    ["agentry_board", "agentry_board_write"],
  );
  for (const tool of added) assert.deepEqual(tool.options, { namespace: "agentry" });
  assert.deepEqual(added[0].input.properties.verb.enum, [
    "status",
    "check",
    "explain",
    "contract",
    "next-id",
    "commits",
    "scan",
    "draft",
  ]);
  assert.deepEqual(added[1].input.properties.verb.enum, ["add", "set", "fix", "draft"]);
});

test("the older host shapes register through the fallbacks; nothing matching registers nothing", async () => {
  const names = [];
  await Plugin.setup({ tool: { transform: (tool) => names.push(tool.name) } });
  await Plugin.setup({ tool: (tool) => names.push(tool.name) });
  assert.deepEqual(names, [
    "agentry_board",
    "agentry_board_write",
    "agentry_board",
    "agentry_board_write",
  ]);
  await Plugin.setup({});
  await Plugin.setup({ tool: { transform: {} } });
});

test("status returns the board's own lines as content", async () => {
  const root = mkBoard();
  const { content } = await boardRead.execute({ verb: "status", root });
  assert.match(content[0].text, /^✓ Sample {2}OK[^\n]*\n\nNow {8}A2 /);
});

test("explain works: the lanes rendering reads the board", async () => {
  const root = mkBoard();
  const { content } = await boardRead.execute({ verb: "explain", root });
  assert.match(content[0].text, /^Sample · docs\/board · 5 kinds · 8 rules on\n/);
});

test("contract and next-id take one id; a missing one is the CLI's own refusal", async () => {
  const root = mkBoard();
  const contract = await boardRead.execute({ verb: "contract", id: "W4", root });
  assert.match(contract.content[0].text, /W4/);
  const nextId = await boardRead.execute({ verb: "next-id", id: "question", root });
  assert.equal(nextId.content[0].text, "Q-03");
  await assert.rejects(
    () => boardRead.execute({ verb: "contract", root }),
    (error) => error.message === SAY.say("board contract", "needs an id", "board contract --help"),
  );
});

test("draft is list-only through the read tool", async () => {
  const root = mkBoard();
  const { content } = await boardRead.execute({ verb: "draft", root });
  assert.equal(content[0].text, "no pending drafts");
});

test("status runs --json when typed true", async () => {
  const root = mkBoard("evidence-board");
  const { content } = await boardRead.execute({ verb: "status", json: true, root });
  const parsed = JSON.parse(content[0].text);
  assert.deepEqual(
    parsed.status.now.map((n) => n.id),
    ["K0"],
  );
});

test("commits is a read the CLI only knows with --learn", async () => {
  const root = mkBoard("table-board", ["feat: a1", "feat: a2", "fix(x): c"]);
  const { content } = await boardRead.execute({ verb: "commits", root });
  assert.match(content[0].text, /learned from 4 first-parent commit\(s\) of main/);
  assert.match(content[0].text, /types {11}feat 2, fix 1,/);
});

test("add previews and writes nothing; the board's files keep their bytes", async () => {
  const root = mkBoard();
  const before = snapshot(root);
  const { content } = await boardWrite.execute({
    verb: "add",
    words: ["sprint"],
    fields: { id: "C1", name: "The workshop" },
    root,
  });
  assert.match(content[0].text, /row C1 under "Sprints" \(BOARD\.md\)/);
  assert.match(content[0].text, /nothing written; add --apply to write it$/);
  assert.deepEqual(snapshot(root), before);
});

test("add with --apply in words writes; the tool never injects one", async () => {
  const root = mkBoard();
  const before = snapshot(root);
  const { content } = await boardWrite.execute({
    verb: "add",
    words: ["sprint", "--apply"],
    fields: { id: "C1", name: "The workshop" },
    root,
  });
  assert.match(content[0].text, /^added sprint C1\n {2}row C1 under "Sprints" \(BOARD\.md\)$/);
  assert.match(
    readFileSync(join(root, "docs", "board", "BOARD.md"), "utf8"),
    /\| C1 \| The workshop \|/,
  );
  assert.notDeepEqual(snapshot(root), before);
});

test("set previews and writes nothing without --apply, and --apply in words writes the one cell", async () => {
  const root = mkBoard();
  const { content } = await boardWrite.execute({
    verb: "set",
    words: ["task", "W4", "status=doing"],
    root,
  });
  assert.match(content[0].text, /nothing written; add --apply to write it$/);
  assert.match(
    readFileSync(join(root, "docs", "board", "BOARD.md"), "utf8"),
    /\| W4 \| A2 \| todo \|/,
  );
  await boardWrite.execute({ verb: "set", words: ["task", "W4", "status=doing", "--apply"], root });
  assert.match(
    readFileSync(join(root, "docs", "board", "BOARD.md"), "utf8"),
    /\| W4 \| A2 \| doing \|/,
  );
});

test("an unknown option trips the exit-2 path and the CLI's ✗ line travels verbatim", async () => {
  const root = mkBoard();
  await assert.rejects(
    () => boardWrite.execute({ verb: "set", words: ["--bogus"], root }),
    (error) => {
      assert.equal(
        error.message,
        SAY.say("board set", 'unknown option "--bogus"', "board set --help"),
      );
      return true;
    },
  );
});
