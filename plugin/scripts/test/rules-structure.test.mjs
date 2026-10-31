// Tests for the structure rules: ids-unique, status-known, refs-resolve, file-required, members-listed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rules } from "../lib/process/rules/structure.mjs";
import { file, makeModel, run, sprint, task } from "./rules-model.mjs";

const rule = (id) => rules.find((r) => r.id === id);
const messages = (found) => found.map((f) => `${f.id}: ${f.message}`);
const members = { kind: "sprint", section: "members", member: "task" };

test("ids-unique passes when every id is listed once", () => {
  const model = makeModel([
    sprint("S1", "todo"),
    task("T1", "S1", "todo"),
    task("T2", "S1", "todo"),
  ]);
  assert.deepEqual(run(rule("ids-unique"), model, {}), []);
});

test("ids-unique names the second listing of an id, with its position", () => {
  const model = makeModel([
    sprint("S1", "todo"),
    task("T1", "S1", "todo"),
    task("T1", "S1", "todo"),
  ]);
  const found = run(rule("ids-unique"), model, {});
  assert.deepEqual(found, [
    {
      rule: "ids-unique",
      kind: "task",
      id: "T1",
      message: "task id listed twice",
      file: "BOARD.md",
      line: 3,
    },
  ]);
});

test("status-known passes for declared statuses", () => {
  const model = makeModel([sprint("S1", "doing"), task("T1", "S1", "verify")]);
  assert.deepEqual(run(rule("status-known"), model, {}), []);
});

test("status-known flags a status outside the kind's values, and an empty one", () => {
  const model = makeModel([sprint("S1", "started"), task("T1", "S1", "")]);
  assert.deepEqual(messages(run(rule("status-known"), model, {})), [
    "S1: unknown status 'started'",
    "T1: unknown status ''",
  ]);
});

test("refs-resolve passes for known parents, multi-kind deps and allowed literals", () => {
  const model = makeModel([
    sprint("S1", "todo"),
    task("T1", "S1", "todo"),
    task("T2", "EXTRA", "later", { deps: ["T1", "S1"] }),
  ]);
  assert.deepEqual(run(rule("refs-resolve"), model, {}), []);
});

test("refs-resolve flags a missing sprint and a dependency on no listed kind", () => {
  const model = makeModel([sprint("S1", "todo"), task("T1", "S9", "todo", { deps: ["nope"] })]);
  assert.deepEqual(messages(run(rule("refs-resolve"), model, {})), [
    "T1: sprint 'S9' is not on the board",
    "T1: deps 'nope' is not on the board",
  ]);
});

test("refs-resolve flags an id that matches two kinds of the field's ref list", () => {
  const model = makeModel([
    sprint("X", "todo"),
    task("X", "X", "todo"),
    task("T2", "X", "todo", { deps: ["X"] }),
  ]);
  const found = run(rule("refs-resolve"), model, {}).filter((f) => f.id === "T2");
  assert.deepEqual(messages(found), ["T2: deps 'X' matches more than one kind"]);
});

test("file-required passes when the file is read, and skips ids the kind exempts", () => {
  const model = makeModel([
    sprint("S1", "todo", { own: file("sprints/S1_a.md") }),
    sprint("PRE", "done"),
  ]);
  assert.deepEqual(run(rule("file-required"), model, {}), []);
});

test("file-required flags a sprint with no file and names the glob", () => {
  const model = makeModel([sprint("S1", "todo")]);
  assert.deepEqual(messages(run(rule("file-required"), model, { kind: "sprint" })), [
    "S1: no file (sprints/{id}_*.md)",
  ]);
});

test("file-required honours the rule's own except", () => {
  const model = makeModel([sprint("S1", "todo")]);
  assert.deepEqual(
    run(rule("file-required"), model, { kind: "sprint", except: { id: ["S1"] } }),
    [],
  );
});

test("members-listed passes when the file's Tasks table matches the board", () => {
  const model = makeModel([
    sprint("S1", "todo", { own: file("sprints/S1_a.md", { rows: ["T1", "T2"] }) }),
    task("T1", "S1", "todo"),
    task("T2", "S1", "todo"),
  ]);
  assert.deepEqual(run(rule("members-listed"), model, members), []);
});

test("members-listed flags a task missing from the file and one the file adds", () => {
  const model = makeModel([
    sprint("S1", "todo", { own: file("sprints/S1_a.md", { rows: ["T1", "T9"] }) }),
    task("T1", "S1", "todo"),
    task("T2", "S1", "todo"),
  ]);
  assert.deepEqual(messages(run(rule("members-listed"), model, members)), [
    "S1: T2 is in S1 on the board but not in its file",
    "S1: T9 is in the file of S1 but not on the board there",
  ]);
});

test("members-listed leaves a sprint with no file to file-required", () => {
  const model = makeModel([sprint("S1", "todo"), task("T1", "S1", "todo")]);
  assert.deepEqual(run(rule("members-listed"), model, members), []);
});

test("members-listed honours except", () => {
  const model = makeModel([
    sprint("S1", "todo", { own: file("sprints/S1_a.md") }),
    task("T1", "S1", "todo"),
  ]);
  assert.equal(run(rule("members-listed"), model, members).length, 1);
  assert.deepEqual(run(rule("members-listed"), model, { ...members, except: { id: ["S1"] } }), []);
});
