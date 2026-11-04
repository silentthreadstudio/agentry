// Ids as a person types them (lib/process/ids.mjs `boardId`, A39): case-insensitive, a decision's cited
// form (`N2` for the decision the board numbers `2`), printed in the board's spelling. Unit cases on the
// synthetic table board, then the CLI reading them the same way. And the next free id in a prefix family
// (`nextInFamily`, `board next-id --family`, field 85).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boardId, nextInFamily } from "../lib/process/ids.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures", "table-board");
const { spec } = loadSpec(join(ROOT, "process.json"));
const model = readProcess({ root: ROOT, spec });
const BOARD = join(HERE, "..", "board.mjs");
const board = (...args) =>
  spawnSync("node", [BOARD, ...args, "--root", ROOT, "--process", join(ROOT, "process.json")], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

test("an id in another case reads as the board's spelling", () => {
  assert.equal(boardId(spec, model, "w1"), "W1");
  assert.equal(boardId(spec, model, "w1", "task"), "W1");
  assert.equal(boardId(spec, model, "W1"), "W1");
});

test("a decision's cited form reads as the plain number the board writes, in any case", () => {
  assert.equal(boardId(spec, model, "N2", "decision"), "2");
  assert.equal(boardId(spec, model, "n2"), "2");
  assert.equal(boardId(spec, model, "2", "decision"), "2");
});

test("an id the board does not hold, or a prefix on another kind, stays as typed", () => {
  assert.equal(boardId(spec, model, "w99"), "w99");
  assert.equal(boardId(spec, model, "N2", "task"), "N2");
  assert.equal(boardId(spec, model, "X2", "decision"), "X2");
});

test("board check --why takes any case and the cited form, and prints the board's spelling", () => {
  const lower = board("check", "--why", "w3");
  assert.notEqual(lower.status, 2, lower.stderr);
  assert.match(lower.stdout, /^W3 /);
  const cited = board("check", "--why", "N2");
  assert.notEqual(cited.status, 2, cited.stderr);
  assert.match(cited.stdout, /^2 /);
});

// A board of bare ids, kind by kind: what `nextInFamily` reads of a model.
const ids = (kinds) => ({
  kinds: Object.fromEntries(
    Object.entries(kinds).map(([k, list]) => [k, { items: list.map((id) => ({ id })) }]),
  ),
});
const FIELD = ids({ task: ["ART-10", "ART-10a", "ART-10d", "ART-14", "ART-18", "W3"] });

test("a family's next id is one above its highest number, suffixed ids counted", () => {
  assert.deepEqual(nextInFamily(FIELD, "ART"), { family: "ART", id: "ART-19" });
});

test("the next id keeps the highest id's separator and zero-padding", () => {
  assert.equal(nextInFamily(ids({ q: ["Q-3", "Q_007"] }), "Q").id, "Q_008");
  assert.equal(nextInFamily(ids({ x: ["X.09"] }), "X").id, "X.10");
  assert.equal(nextInFamily(ids({ t: ["T9", "T-2"] }), "T").id, "T10");
});

test("a family with no id on the board starts at <family>-1, as typed", () => {
  assert.equal(nextInFamily(FIELD, "ZZ").id, "ZZ-1");
  assert.equal(nextInFamily(FIELD, "zz").id, "zz-1");
});

test("a family matches in any case and answers in the case of the ids found", () => {
  assert.equal(nextInFamily(FIELD, "art").id, "ART-19");
  assert.equal(nextInFamily(ids({ t: ["art-4"] }), "ART").id, "art-5");
});

test("a family that ends in a separator is read without it", () => {
  assert.deepEqual(nextInFamily(FIELD, "ART-"), { family: "ART", id: "ART-19" });
  assert.equal(nextInFamily(FIELD, "ART_").id, "ART-19");
});

test("a family with no letter is refused", () => {
  assert.ok(nextInFamily(FIELD, "12").error);
  assert.ok(nextInFamily(FIELD, "-").error);
});

test("a family never counts a longer prefix", () => {
  const board = ids({ task: ["ART-3", "ARTX-30", "PART-40"] });
  assert.equal(nextInFamily(board, "ART").id, "ART-4");
  assert.equal(nextInFamily(ids({ task: ["ARTX-30", "PART-40"] }), "ART").id, "ART-1");
});

test("an id on any kind counts toward the family", () => {
  const board = ids({ task: ["ART-10"], later: ["ART-25"], note: ["ART-2"] });
  assert.equal(nextInFamily(board, "ART").id, "ART-26");
});

test("next-id --family answers even when create.id is ask or unset, across kinds", () => {
  const ask = board("next-id", "task", "--family", "W");
  assert.deepEqual([ask.status, ask.stdout], [0, "W10\n"]);
  const unset = board("next-id", "milestone", "--family", "m");
  assert.deepEqual([unset.status, unset.stdout], [0, "M3\n"]);
  const other = board("next-id", "question", "--family", "x-");
  assert.deepEqual([other.status, other.stdout], [0, "X-02\n"]);
});

test("next-id --family --json prints kind, family and id", () => {
  const out = board("next-id", "task", "--family=W", "--json");
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { kind: "task", family: "W", id: "W10" });
});

test("next-id refuses --family with no value or with no letter", () => {
  for (const args of [["--family"], ["--family", "--json"], ["--family="], ["--family", "12"]]) {
    const out = board("next-id", "task", ...args);
    assert.equal(out.status, 2, args.join(" "));
    assert.match(out.stderr, /^✗ board next-id: --family/, args.join(" "));
  }
});

test("next-id on a kind chosen by hand names the --family way on", () => {
  const out = board("next-id", "task");
  assert.equal(out.status, 2);
  assert.match(
    out.stderr,
    /\(create\.id is "ask"\) → (agentry )?board next-id task --family <prefix>$/m,
  );
});

test("next-id without --family reads the create.id pattern as before", () => {
  const out = board("next-id", "question", "--json");
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { kind: "question", id: "Q-03" });
});

test("/agentry:new's id step uses --family for a kind whose ids are chosen by hand", () => {
  const step = readFileSync(join(HERE, "..", "..", "commands", "new.md"), "utf8")
    .split("\n")
    .find((l) => l.includes("**Ask only the kind's"));
  assert.match(step, /board next-id <kind> --family <prefix>/);
});
