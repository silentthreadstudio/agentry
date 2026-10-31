// Tests for the evidence rules: done-has-evidence, done-has-handoff, flagged-needs-verdict,
// closed-children, done-signoff.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rules } from "../lib/process/rules/evidence.mjs";
import { file, hasOnly, makeModel, run, sprint, task } from "./rules-model.mjs";

const rule = (id) => rules.find((r) => r.id === id);
const messages = (found) => found.map((f) => `${f.id}: ${f.message}`);
const SHA = "abc1234";
const OTHER = "def5678";

// ---- done-has-evidence

const evidence = (mode, field = "commit") => ({ kind: "task", field, evidence: mode });

test("done-has-evidence (commit) passes for a done task naming a commit git knows", () => {
  const model = makeModel([sprint("S1", "doing"), task("T1", "S1", "done", { commit: [SHA] })]);
  assert.deepEqual(run(rule("done-has-evidence"), model, evidence("commit"), hasOnly(SHA)), []);
});

test("done-has-evidence (commit) flags no commit, and a commit git does not have", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "done", { commit: [] }),
    task("T2", "S1", "done", { commit: [SHA, OTHER] }),
  ]);
  assert.deepEqual(
    messages(run(rule("done-has-evidence"), model, evidence("commit"), hasOnly(SHA))),
    ["T1: done without a commit", `T2: commit ${OTHER} is not in git`],
  );
});

test("done-has-evidence (commit) does not accept a note in place of a commit", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "done", { commit: "reload check left" }),
  ]);
  assert.deepEqual(messages(run(rule("done-has-evidence"), model, evidence("commit"))), [
    "T1: done without a commit",
  ]);
});

test("done-has-evidence (commit-or-note) accepts a note alone, a commit alone, or both", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "done", { commit: "reload check left" }),
    task("T2", "S1", "done", { commit: SHA }),
    task("T3", "S1", "done", { commit: `${SHA} PASS WITH NOTES` }),
  ]);
  assert.deepEqual(
    run(rule("done-has-evidence"), model, evidence("commit-or-note"), hasOnly(SHA)),
    [],
  );
});

test("done-has-evidence (commit-or-note) flags an empty cell and still checks any commit named", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "done", { commit: "" }),
    task("T2", "S1", "done", { commit: `${OTHER} verified` }),
  ]);
  assert.deepEqual(
    messages(run(rule("done-has-evidence"), model, evidence("commit-or-note"), hasOnly(SHA))),
    ["T1: done without a commit or a note", `T2: commit ${OTHER} is not in git`],
  );
});

test("done-has-evidence ignores tasks that are not done, and honours except", () => {
  const model = makeModel([
    sprint("PRE", "done"),
    task("T1", "PRE", "done", { commit: [] }),
    task("T2", "PRE", "doing", { commit: [] }),
  ]);
  assert.equal(run(rule("done-has-evidence"), model, evidence("commit")).length, 1);
  assert.deepEqual(
    run(rule("done-has-evidence"), model, { ...evidence("commit"), except: { sprint: ["PRE"] } }),
    [],
  );
});

// ---- done-has-handoff

const handoffModel = (leads, commit = [SHA]) =>
  makeModel([
    sprint("S1", "doing", { own: file("sprints/S1_a.md", { leads }) }),
    task("T1", "S1", "done", { commit }),
  ]);
const handoff = (commit) => ({ kind: "task", section: "handoff", commit });

test("done-has-handoff (first) passes when the lead names the task and its first commit", () => {
  const model = handoffModel([{ lead: "T1", text: `- **T1** (${SHA}): did it` }], [SHA, OTHER]);
  assert.deepEqual(run(rule("done-has-handoff"), model, handoff("first")), []);
});

test("done-has-handoff (first) flags a line naming only a later commit, (any) accepts it", () => {
  const model = handoffModel([{ lead: "T1", text: `- **T1** (${OTHER}): did it` }], [SHA, OTHER]);
  assert.deepEqual(messages(run(rule("done-has-handoff"), model, handoff("first"))), [
    "T1: handoff line in sprints/S1_a.md names no matching commit",
  ]);
  assert.deepEqual(run(rule("done-has-handoff"), model, handoff("any")), []);
});

test("done-has-handoff matches a short sha against a longer one in the line", () => {
  const model = handoffModel([{ lead: "T1", text: `- **T1** (${SHA}9999): did it` }]);
  assert.deepEqual(run(rule("done-has-handoff"), model, handoff("first")), []);
});

test("done-has-handoff (none) needs only a lead that names the task", () => {
  const model = handoffModel([{ lead: "T1" }], []);
  assert.deepEqual(run(rule("done-has-handoff"), model, handoff("none")), []);
});

test("done-has-handoff reads a task out of a combined or annotated lead, never a prefix of it", () => {
  const model = makeModel([
    sprint("S1", "doing", {
      own: file("sprints/S1_a.md", {
        leads: [{ lead: "T1/T2" }, { lead: "T3 merged" }, { lead: "T40" }],
      }),
    }),
    task("T1", "S1", "done"),
    task("T2", "S1", "done"),
    task("T3", "S1", "done"),
    task("T4", "S1", "done"),
  ]);
  assert.deepEqual(messages(run(rule("done-has-handoff"), model, handoff("none"))), [
    "T4: no handoff line in sprints/S1_a.md",
  ]);
});

test("done-has-handoff flags a missing line, and a sprint with no file", () => {
  const model = makeModel([
    sprint("S1", "doing", { own: file("sprints/S1_a.md") }),
    sprint("S2", "doing"),
    task("T1", "S1", "done"),
    task("T2", "S2", "done"),
  ]);
  assert.deepEqual(messages(run(rule("done-has-handoff"), model, handoff("none"))), [
    "T1: no handoff line in sprints/S1_a.md",
    "T2: sprint S2 has no file (sprints/{id}_*.md)",
  ]);
});

test("done-has-handoff honours except, and does not run for a task that is not done", () => {
  const model = makeModel([
    sprint("TRK", "doing", { own: file("sprints/TRK_a.md") }),
    task("T1", "TRK", "done"),
    task("T2", "TRK", "doing"),
  ]);
  assert.equal(run(rule("done-has-handoff"), model, handoff("none")).length, 1);
  assert.deepEqual(
    run(rule("done-has-handoff"), model, { ...handoff("none"), except: { sprint: ["TRK"] } }),
    [],
  );
});

// ---- flagged-needs-verdict

const verdict = {
  kind: "task",
  flag: "risky",
  verdict: "verdict",
  pass: ["PASS", "PASS WITH NOTES"],
};

test("flagged-needs-verdict passes for a flagged done task with a passing verdict in any case", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "done", { risky: true, verdict: "pass with notes" }),
    task("T2", "S1", "done", { risky: false, verdict: "" }),
  ]);
  assert.deepEqual(run(rule("flagged-needs-verdict"), model, verdict), []);
});

test("flagged-needs-verdict flags a flagged done task with a failing or empty verdict", () => {
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "done", { risky: true, verdict: "FAIL" }),
    task("T2", "S1", "done", { risky: true, verdict: "" }),
    task("T3", "S1", "doing", { risky: true, verdict: "" }),
  ]);
  assert.deepEqual(
    run(rule("flagged-needs-verdict"), model, verdict).map((f) => f.id),
    ["T1", "T2"],
  );
});

// ---- closed-children

test("closed-children passes when every child of a done parent is done, cut or later", () => {
  const model = makeModel([
    sprint("S1", "done"),
    task("T1", "S1", "done"),
    task("T2", "S1", "cut"),
    task("T3", "S1", "later"),
  ]);
  assert.deepEqual(run(rule("closed-children"), model, { kind: "sprint" }), []);
});

test("closed-children flags a done parent with open children, and ignores parents not done", () => {
  const model = makeModel([
    sprint("S1", "done"),
    sprint("S2", "doing"),
    task("T1", "S1", "verify"),
    task("T2", "S1", "todo"),
    task("T3", "S2", "todo"),
  ]);
  assert.deepEqual(messages(run(rule("closed-children"), model, { kind: "sprint" })), [
    "S1: done with open T1, T2",
  ]);
});

test("closed-children honours except", () => {
  const model = makeModel([sprint("PRE", "done"), task("T1", "PRE", "todo")]);
  assert.deepEqual(
    run(rule("closed-children"), model, { kind: "sprint", except: { id: ["PRE"] } }),
    [],
  );
});

// ---- done-signoff

test("done-signoff passes for a done sprint with a dated sign-off", () => {
  const model = makeModel([
    sprint("S1", "done", { ok: "2026-10-31" }),
    sprint("S2", "doing", { ok: "" }),
  ]);
  assert.deepEqual(run(rule("done-signoff"), model, { kind: "sprint", field: "ok" }), []);
});

test("done-signoff flags a done sprint with an empty or undated sign-off", () => {
  const model = makeModel([sprint("S1", "done", { ok: "" }), sprint("S2", "done", { ok: "yes" })]);
  assert.deepEqual(
    run(rule("done-signoff"), model, { kind: "sprint", field: "ok" }).map((f) => f.id),
    ["S1", "S2"],
  );
});

test("done-signoff honours except", () => {
  const model = makeModel([sprint("PRE", "done", { ok: "" })]);
  assert.deepEqual(
    run(rule("done-signoff"), model, { kind: "sprint", field: "ok", except: { id: ["PRE"] } }),
    [],
  );
});
