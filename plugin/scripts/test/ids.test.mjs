// Ids as a person types them (lib/process/ids.mjs `boardId`, A39): case-insensitive, a decision's cited
// form (`N2` for the decision the board numbers `2`), printed in the board's spelling. Unit cases on the
// synthetic table board, then the CLI reading them the same way.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boardId } from "../lib/process/ids.mjs";
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
