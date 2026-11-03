// Tests for the `mentions` field type: free text that cites ids by a prefix (`N2`), each of which must
// be an item of the kind the field refs. Fixture: table-board, whose question "Answer" cell cites a
// decision as `N2` (decision ids are plain numbers, `N` is their display prefix).
// Run: node --test plugin/scripts/test/field-mentions.test.mjs
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cellValue } from "../lib/process/markdown.mjs";
import { VALID, brokenBoard, outcome } from "./broken-boards.mjs";

const MENTIONS = { column: "Answer", type: "mentions", ref: "decision", prefix: "N" };
const withAnswer = (field) => {
  const spec = structuredClone(VALID);
  spec.kinds.question.fields.answer = field;
  spec.rules = [{ rule: "refs-resolve" }];
  return spec;
};

// A table-board whose first answer reads `answer`; the caller removes it.
function boardAnswering(answer) {
  const root = brokenBoard();
  const board = join(root, "docs", "board", "BOARD.md");
  writeFileSync(board, readFileSync(board, "utf8").replace("| W3 | N2 |", `| W3 | ${answer} |`));
  return root;
}
const judged = (answer, field = MENTIONS) => {
  const root = boardAnswering(answer);
  try {
    return outcome(withAnswer(field), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("a mentions cell reads as the prefixed ids in its text, once each", () => {
  assert.deepEqual(cellValue("see N2, and N9; N2 again", MENTIONS), ["N2", "N9"]);
  assert.deepEqual(cellValue("no ids here", MENTIONS), []);
});

test("a mentions cell ignores a prefix inside a word or a longer token", () => {
  assert.deepEqual(cellValue("AN2 N2x N2.5 xN3", MENTIONS), []);
});

test("refs-resolve passes when every mentioned id is an item of the ref kind", () => {
  assert.deepEqual(judged("N2 settles it").messages, []);
});

test("refs-resolve reports a mention that names no item, naming the field and the id", () => {
  const r = judged("see N2 and N9");
  assert.equal(r.exit, 1);
  assert.deepEqual(r.messages, ["refs-resolve: answer 'N9' is not on the board"]);
});

test("a plain text field is not scanned: the same answer passes without the type", () => {
  assert.deepEqual(judged("N9", { column: "Answer" }).messages, []);
});

test("the process file refuses mentions without a prefix or a ref, and a prefix elsewhere", () => {
  const bad = (field) => outcome(withAnswer(field), brokenBoard());
  const messages = (field) => {
    const r = bad(field);
    return r.messages.join(" | ");
  };
  assert.match(messages({ column: "Answer", type: "mentions", ref: "decision" }), /prefix/);
  assert.match(messages({ column: "Answer", type: "mentions", prefix: "N" }), /ref/);
  assert.match(messages({ column: "Answer", prefix: "N" }), /prefix.*mentions/);
});
