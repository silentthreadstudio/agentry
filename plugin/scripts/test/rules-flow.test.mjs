// Tests for the flow rules: deps-done, parent-active, sequential, question-blocks, parked, deps-not-forward.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rules } from "../lib/process/rules/flow.mjs";
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
