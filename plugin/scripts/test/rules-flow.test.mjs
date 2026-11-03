// Tests for the flow rules: deps-done, parent-active, sequential, question-blocks, parked, deps-not-forward.
import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rules } from "../lib/process/rules/flow.mjs";
import { VALID, brokenBoard, outcome } from "./broken-boards.mjs";
import { makeModel, question, run, sprint, task } from "./rules-model.mjs";

const rule = (id) => rules.find((r) => r.id === id);
const messages = (found) => found.map((f) => `${f.id}: ${f.message}`);

test("deps-done passes when a started task's dependencies are all done", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "done"),
    task("T2", "S1", "doing", { deps: ["T1"] }),
    task("T3", "S1", "todo", { deps: ["T2"] }),
  ]);
  assert.deepEqual(run(rule("deps-done"), model, { kind: "task", field: "deps" }), []);
});

test("deps-done flags a started task whose dependency is not done", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "verify"),
    task("T2", "S1", "doing", { deps: ["T1"] }),
  ]);
  assert.deepEqual(messages(run(rule("deps-done"), model, { kind: "task", field: "deps" })), [
    "T2: doing, but depends on T1 (task, verify)",
  ]);
});

test("deps-done reads a sprint or a milestone as a dependency through its phase", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    sprint("S2", "doing"),
    { kind: "milestone", id: "M1", phase: "active", sprints: ["S1"] },
    task("T1", "S2", "doing", { deps: ["S1", "M1"] }),
  ]);
  assert.deepEqual(messages(run(rule("deps-done"), model, { kind: "task", field: "deps" })), [
    "T1: doing, but depends on S1 (sprint, doing)",
    "T1: doing, but depends on M1 (milestone, active)",
  ]);
});

test("deps-done reads a shared id as the first kind of the ref list (sprint before milestone)", () => {
  const model = makeModel([
    { kind: "milestone", id: "S1", phase: "done", sprints: ["S1"] },
    sprint("S1", "doing"),
    sprint("S2", "doing"),
    task("T1", "S2", "doing", { deps: ["S1"] }),
  ]);
  assert.deepEqual(messages(run(rule("deps-done"), model, { kind: "task", field: "deps" })), [
    "T1: doing, but depends on S1 (sprint, doing)",
  ]);
});

test("deps-done accepts a done sprint dependency, and infers the field when none is given", () => {
  const model = makeModel([
    sprint("S1", "done"),
    sprint("S2", "doing"),
    task("T1", "S2", "doing", { deps: ["S1"] }),
  ]);
  assert.deepEqual(run(rule("deps-done"), model, { kind: "task" }), []);
});

test("deps-done honours except", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "todo"),
    task("T2", "S1", "doing", { deps: ["T1"] }),
  ]);
  const params = { kind: "task", field: "deps" };
  assert.equal(run(rule("deps-done"), model, params).length, 1);
  assert.deepEqual(run(rule("deps-done"), model, { ...params, except: { sprint: ["S1"] } }), []);
});

test("parent-active passes for started tasks in a doing or done sprint, and for unstarted ones anywhere", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    sprint("S2", "todo"),
    task("T1", "S1", "done"),
    task("T2", "S2", "todo"),
    task("T3", "S2", "cut"),
    task("T4", "EXTRA", "later"),
  ]);
  assert.deepEqual(run(rule("parent-active"), model, { kind: "task" }), []);
});

test("parent-active flags a started task in a sprint that has not started", () => {
  const model = makeModel([sprint("S1", "todo"), task("T1", "S1", "doing")]);
  assert.deepEqual(messages(run(rule("parent-active"), model, { kind: "task" })), [
    "T1: doing, but sprint S1 is todo",
  ]);
});

test("parent-active honours except", () => {
  const model = makeModel([sprint("S1", "todo"), task("T1", "S1", "doing")]);
  assert.deepEqual(run(rule("parent-active"), model, { kind: "task", except: { id: ["T1"] } }), []);
});

test("sequential passes when each started sprint follows a done one, skipping listed ids", () => {
  const model = makeModel([
    sprint("PRE", "done"),
    sprint("S1", "done"),
    sprint("TRK", "doing"),
    sprint("S2", "doing"),
    sprint("S3", "todo"),
  ]);
  assert.deepEqual(run(rule("sequential"), model, { kind: "sprint", skip: ["TRK"] }), []);
});

test("sequential flags a sprint started before the one above it is done", () => {
  const model = makeModel([sprint("S1", "doing"), sprint("S2", "doing")]);
  assert.deepEqual(messages(run(rule("sequential"), model, { kind: "sprint" })), [
    "S2: doing, but S1 is doing",
  ]);
});

test("sequential does not let a skipped sprint stand as the previous one", () => {
  const model = makeModel([sprint("S1", "done"), sprint("TRK", "todo"), sprint("S2", "doing")]);
  assert.deepEqual(run(rule("sequential"), model, { kind: "sprint", skip: ["TRK"] }), []);
  assert.equal(run(rule("sequential"), model, { kind: "sprint" }).length, 1);
});

test("question-blocks passes when only unstarted work waits on an open question", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "todo"),
    task("T2", "S1", "doing"),
    question("Q1", "open", ["T1"]),
    question("Q2", "answered", ["T2"]),
  ]);
  assert.deepEqual(run(rule("question-blocks"), model, { kind: "question", field: "blocks" }), []);
});

test("question-blocks flags a started task named by an open question, once with every question", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "verify"),
    question("Q1", "open", ["T1"]),
    question("Q2", "open", ["T1"]),
  ]);
  const found = run(rule("question-blocks"), model, { kind: "question", field: "blocks" });
  assert.deepEqual(messages(found), ["T1: verify, but blocked by open Q1, Q2"]);
  assert.equal(found[0].kind, "task");
});

test("question-blocks honours except on the question", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "doing"),
    question("Q1", "open", ["T1"]),
  ]);
  assert.deepEqual(
    run(rule("question-blocks"), model, { kind: "question", except: { id: ["Q1"] } }),
    [],
  );
});

test("parked passes when the parking sprint holds only later tasks and nothing live waits on them", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "doing"),
    task("T2", "EXTRA", "later", { deps: ["T1"] }),
    task("T3", "S1", "cut", { deps: ["T2"] }),
  ]);
  assert.deepEqual(run(rule("parked"), model, { kind: "task", parking: "EXTRA" }), []);
});

test("parked flags a live task in the parking sprint and a live task waiting on parked work", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "EXTRA", "todo"),
    task("T2", "S1", "later"),
    task("T3", "S1", "todo", { deps: ["T2"] }),
  ]);
  assert.deepEqual(messages(run(rule("parked"), model, { kind: "task", parking: "EXTRA" })), [
    "T1: sits in EXTRA but is todo",
    "T3: todo, but depends on T2, which is later",
  ]);
});

test("deps-not-forward passes for dependencies at or above the task's sprint", () => {
  const model = makeModel([
    sprint("S1", "done"),
    sprint("S2", "doing"),
    task("T1", "S1", "done"),
    task("T2", "S2", "doing", { deps: ["T1", "S1"] }),
    task("T3", "S2", "todo", { deps: ["T2"] }),
  ]);
  assert.deepEqual(run(rule("deps-not-forward"), model, { kind: "task", field: "deps" }), []);
});

test("deps-not-forward flags a dependency on a task of a later sprint", () => {
  const model = makeModel([
    sprint("S1", "todo"),
    sprint("S2", "todo"),
    task("T1", "S1", "todo", { deps: ["T2"] }),
    task("T2", "S2", "todo"),
  ]);
  assert.deepEqual(
    messages(run(rule("deps-not-forward"), model, { kind: "task", field: "deps" })),
    ["T1: depends on T2, which comes later in the order"],
  );
});

test("deps-not-forward leaves skipped sprints outside the order, on either side", () => {
  const model = makeModel([
    sprint("S1", "todo"),
    sprint("TRK", "todo"),
    task("T1", "S1", "todo", { deps: ["T2"] }),
    task("T2", "TRK", "todo", { deps: ["T1"] }),
  ]);
  assert.deepEqual(
    run(rule("deps-not-forward"), model, { kind: "task", field: "deps", skip: ["TRK"] }),
    [],
  );
  assert.equal(run(rule("deps-not-forward"), model, { kind: "task", field: "deps" }).length, 1);
});

test("the rules that read ids take a value of any shape: one id as a list of one, never a throw", () => {
  // As a frontmatter value or a hand-built model may hold it, whatever the field's type says.
  const shapes = (id) => [id, [id, 7, null], 7, null, true, { [id]: 1 }];
  const cases = [
    ["deps-done", { kind: "task", field: "deps" }],
    ["parked", { kind: "task", parking: "LATER", field: "deps" }],
    ["deps-not-forward", { kind: "task", field: "deps" }],
    ["question-blocks", { kind: "question", field: "blocks" }],
  ];
  for (const [n, [deps, blocks]] of shapes("T1")
    .map((d, i) => [d, shapes("T2")[i]])
    .entries()) {
    const model = makeModel([
      sprint("S1", "doing"),
      sprint("LATER", "todo"),
      task("T1", "LATER", "later"),
      task("T2", "S1", "doing", { deps }),
      question("Q1", "open", blocks),
    ]);
    for (const [id, params] of cases) {
      const what = `${id} on ${JSON.stringify(id === "question-blocks" ? blocks : deps)}`;
      assert.equal(run(rule(id), model, params).length, n < 2 ? 1 : 0, what);
    }
  }
});

// ready-has-contract: the ctx answers `contractOf(kind, id)` the way the board's contract lookup does.
const contracts = (...found) => ({
  contractOf: (_kind, id) => ({ status: found.includes(id) ? "found" : "not-found" }),
});
const ready = (model, params, ...found) =>
  run(rule("ready-has-contract"), model, { kind: "task", ...params }, contracts(...found));

test("ready-has-contract flags an unfinished task in an open sprint with no contract, naming it and where to add one", () => {
  const model = makeModel([sprint("S1", "doing"), task("T1", "S1", "todo")]);
  const [found] = ready(model, {});
  assert.equal(found.id, "T1");
  assert.match(found.message, /T1 .*S1/);
  assert.match(found.message, /board contract T1/);
});

test("ready-has-contract passes a task whose contract is found", () => {
  const model = makeModel([sprint("S1", "doing"), task("T1", "S1", "doing")]);
  assert.deepEqual(ready(model, {}, "T1"), []);
});

test("ready-has-contract ignores done and parked tasks, and tasks in a sprint that is not open", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    sprint("S2", "todo"),
    sprint("S3", "done"),
    task("T1", "S1", "done"),
    task("T2", "S1", "later"),
    task("T3", "S2", "todo"),
    task("T4", "S3", "todo"),
  ]);
  assert.deepEqual(ready(model, {}), []);
});

test("ready-has-contract honours skip (a task or its sprint) and except", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    sprint("S2", "doing"),
    task("T1", "S1", "todo"),
    task("T2", "S2", "todo"),
    task("T3", "S2", "todo", { risky: true }),
  ]);
  assert.deepEqual(
    ready(model, { skip: ["T1", "S2"] }).map((f) => f.id),
    [],
  );
  assert.deepEqual(
    ready(model, { except: { risky: [true] } }).map((f) => f.id),
    ["T1", "T2"],
  );
});

test("ready-has-contract reports an ambiguous contract as not usable", () => {
  const model = makeModel([sprint("S1", "doing"), task("T1", "S1", "todo")]);
  const ctx = { contractOf: () => ({ status: "ambiguous" }) };
  const [found] = run(rule("ready-has-contract"), model, { kind: "task" }, ctx);
  assert.match(found.message, /more than one/);
});

test("ready-has-contract on a real board: finds the missing contract, clears once it is written", () => {
  const root = brokenBoard("ready-has-contract");
  try {
    const spec = { ...VALID, rules: [{ rule: "ready-has-contract", kind: "task", skip: ["TRK"] }] };
    const before = outcome(spec, root).messages;
    assert.equal(before.length, 1, before.join(" | "));
    assert.match(
      before[0],
      /^ready-has-contract: W4 is open in sprint A2 with no contract; add a .*TASKS\.md/,
    );
    const tasks = join(root, "docs", "board", "TASKS.md");
    appendFileSync(
      tasks,
      "\n**W4 · Evening events** (A2): owns `src/events.mjs` · accept: events fire.\n",
    );
    assert.deepEqual(outcome(spec, root).messages, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
