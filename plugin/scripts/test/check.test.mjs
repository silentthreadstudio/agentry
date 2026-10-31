// Tests for lib/process/check.mjs (Model x enabled rules -> Finding[]) and the mapping from the original
// board checker's rules R1..R12 onto the catalog.
//
//   original  catalog rule(s)                          failing case (this file's mutation table below)
//   R1        ids-unique, status-known, refs-resolve   duplicate id; unknown status; sprint not on the board
//   R2        file-required, members-listed            sprint without its file; file lists a task not on the board
//   R3        refs-resolve                             dependency that is not on the board
//   R4        deps-done                                started task with an unfinished dependency
//   R5        parent-active                            started task in a sprint that has not started
//   R6        done-has-evidence, done-has-handoff      done without a commit; commit not in git; no handoff line
//   R7        flagged-needs-verdict                    flagged task done without a passing verdict
//   R8        closed-children, done-signoff            done sprint with an open task; done sprint without a date
//   R9        sequential                               sprint started while the one before it is not done
//   R10       question-blocks                          started task named by an open question
//   R11       parked                                   live task in the parking sprint; live task waiting on parked work
//   R12       deps-not-forward                         dependency on a task of a later sprint
//
// Per-rule passing/failing/except/skip cases live in rules-{structure,flow,evidence}.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "../lib/process/check.mjs";
import { file, hasAll, hasOnly, makeModel, question, sprint, task } from "./rules-model.mjs";

const EXEMPT = ["PRE", "TRK", "LATER"];
const RULES = [
  { rule: "ids-unique", label: "R1" },
  { rule: "status-known", label: "R1" },
  { rule: "refs-resolve", label: "R1/R3" },
  { rule: "file-required", label: "R2", kind: "sprint" },
  {
    rule: "members-listed",
    label: "R2",
    kind: "sprint",
    section: "members",
    member: "task",
    except: { id: EXEMPT },
  },
  { rule: "deps-done", label: "R4", kind: "task", field: "deps" },
  { rule: "parent-active", label: "R5", kind: "task" },
  {
    rule: "done-has-evidence",
    label: "R6",
    kind: "task",
    field: "commit",
    evidence: "commit",
    except: { sprint: ["PRE"] },
  },
  {
    rule: "done-has-handoff",
    label: "R6",
    kind: "task",
    section: "handoff",
    commit: "first",
    except: { sprint: ["PRE"] },
  },
  {
    rule: "flagged-needs-verdict",
    label: "R7",
    kind: "task",
    flag: "risky",
    verdict: "verdict",
    pass: ["PASS", "PASS WITH NOTES"],
  },
  { rule: "closed-children", label: "R8", kind: "sprint", except: { id: EXEMPT } },
  { rule: "done-signoff", label: "R8", kind: "sprint", field: "ok", except: { id: EXEMPT } },
  { rule: "sequential", label: "R9", kind: "sprint", skip: EXEMPT },
  { rule: "question-blocks", label: "R10", kind: "question", field: "blocks" },
  { rule: "parked", label: "R11", kind: "task", parking: "LATER" },
  { rule: "deps-not-forward", label: "R12", kind: "task", field: "deps", skip: ["TRK", "LATER"] },
];
const SHA = "abc1234";

// A board on which every rule above holds.
const clean = () => [
  sprint("PRE", "done", { ok: "2026-01-01" }),
  sprint("S1", "done", {
    ok: "2026-02-01",
    own: file("sprints/S1_a.md", {
      rows: ["T1"],
      leads: [{ lead: "T1", text: `- **T1** (${SHA}): done` }],
    }),
  }),
  sprint("S2", "doing", { ok: "", own: file("sprints/S2_b.md", { rows: ["T2", "T3"] }) }),
  sprint("TRK", "doing", { ok: "" }),
  sprint("LATER", "todo", { ok: "" }),
  task("P1", "PRE", "done", { commit: [SHA] }),
  task("T1", "S1", "done", { commit: [SHA], risky: true, verdict: "PASS" }),
  task("T2", "S2", "doing", { deps: ["T1"] }),
  task("T3", "S2", "todo", { deps: ["T2"] }),
  task("L1", "LATER", "later"),
  question("Q1", "open", ["T3"]),
];
const find = (items, id) => items.find((i) => i.id === id);

const findings = (items, ctx = hasOnly(SHA)) => check(makeModel(items), RULES, ctx);

test("the clean board reports nothing", () => {
  assert.deepEqual(findings(clean()), []);
});

// [original rule, catalog rule that must report, mutation]
const MUTATIONS = [
  ["R1", "ids-unique", (b) => b.push(task("T3", "S2", "todo"))],
  ["R1", "status-known", (b) => Object.assign(find(b, "T3"), { status: "paused" })],
  ["R1", "refs-resolve", (b) => Object.assign(find(b, "T3"), { sprint: "S9" })],
  ["R2", "file-required", (b) => Object.assign(find(b, "S2"), { own: undefined })],
  ["R2", "members-listed", (b) => find(b, "S2").own.sections.members.rows.push({ Task: "T9" })],
  ["R3", "refs-resolve", (b) => Object.assign(find(b, "T3"), { deps: ["T404"] })],
  ["R4", "deps-done", (b) => Object.assign(find(b, "T2"), { deps: ["T3"] })],
  ["R5", "parent-active", (b) => b.push(sprint("S3", "todo"), task("T5", "S3", "doing"))],
  ["R6", "done-has-evidence", (b) => Object.assign(find(b, "T1"), { commit: [] })],
  ["R6", "done-has-handoff", (b) => find(b, "S1").own.sections.handoff.leads.pop()],
  ["R7", "flagged-needs-verdict", (b) => Object.assign(find(b, "T1"), { verdict: "" })],
  ["R8", "closed-children", (b) => b.push(task("T6", "S1", "todo"))],
  ["R8", "done-signoff", (b) => Object.assign(find(b, "S1"), { ok: "" })],
  ["R9", "sequential", (b) => Object.assign(find(b, "S1"), { status: "todo" })],
  ["R10", "question-blocks", (b) => Object.assign(find(b, "Q1"), { blocks: ["T2"] })],
  ["R11", "parked", (b) => Object.assign(find(b, "L1"), { status: "todo" })],
  [
    "R12",
    "deps-not-forward",
    (b) =>
      b.push(
        sprint("S3", "todo"),
        task("T7", "S3", "todo"),
        Object.assign(find(b, "T3"), { deps: ["T7"] }),
      ),
  ],
];

for (const [original, ruleId, mutate] of MUTATIONS) {
  test(`${original}: the catalog reports ${ruleId} when the board breaks it`, () => {
    const items = clean();
    mutate(items);
    const found = findings(items).filter((f) => f.rule === ruleId);
    assert.ok(found.length > 0, `${ruleId} did not report`);
    assert.ok(found.every((f) => f.label?.startsWith("R")));
  });
}

test("R6: a commit that git does not have is reported through ctx.hasCommit", () => {
  const found = findings(clean(), hasOnly()).filter((f) => f.rule === "done-has-evidence");
  assert.deepEqual(
    found.map((f) => f.message),
    [`commit ${SHA} is not in git`],
  );
});

test("findings carry the entry's label, and entries without one add none", () => {
  const items = clean();
  Object.assign(find(items, "T3"), { deps: ["T404"] });
  const labelled = check(makeModel(items), RULES, hasAll).find((f) => f.rule === "refs-resolve");
  assert.equal(labelled.label, "R1/R3");
  const bare = check(makeModel(items), [{ rule: "refs-resolve" }], hasAll)[0];
  assert.equal("label" in bare, false);
});

test("a rule that cannot run becomes a finding instead of a throw", () => {
  const model = makeModel(clean());
  const found = check(
    model,
    [
      { rule: "no-such-rule" },
      { rule: "deps-done", kind: "nope" },
      { rule: "done-signoff", kind: "sprint" },
    ],
    hasAll,
  );
  assert.deepEqual(
    found.map((f) => f.message),
    [
      "rule cannot run: unknown rule",
      "rule cannot run: unknown kind 'nope'",
      "rule cannot run: missing param 'field'",
    ],
  );
});

test("an except or skip value that names nothing on the board is a finding naming it", () => {
  const evidence = { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" };
  const strays = (entry, model = makeModel(clean())) =>
    check(model, [entry], hasAll)
      .filter((f) => f.message.startsWith("rules[0]."))
      .map((f) => f.message);
  const cases = [
    [{ ...evidence, except: { sprint: ["PREE", "PRE"] } }, ['except.sprint names no item "PREE"']],
    [{ ...evidence, except: { sprint: ["S9", "EXTRA"] } }, ['except.sprint names no item "S9"']],
    [{ ...evidence, except: { id: ["T1", "S1"] } }, ['except.id names no item "S1"']],
    [
      { ...evidence, except: { status: ["doing", "doin"] } },
      ['except.status names no item "doin"'],
    ],
    [{ rule: "sequential", kind: "sprint", skip: ["TRK", "TRKK"] }, ['skip names no item "TRKK"']],
    [
      {
        rule: "deps-not-forward",
        kind: "task",
        field: "deps",
        skip: ["T1", "S1", "LATER", "LATR"],
      },
      ['skip names no item "LATR"'],
    ],
  ];
  for (const [entry, expected] of cases)
    assert.deepEqual(
      strays(entry),
      expected.map((m) => `rules[0].${m}`),
      JSON.stringify(entry),
    );
  const unread = makeModel(clean());
  unread.kinds.sprint.located = false;
  assert.deepEqual(strays(cases[0][0], unread), [], "a kind the reader did not find is not judged");
});

test("only the enabled rules run, in the order given", () => {
  const items = clean();
  Object.assign(find(items, "T2"), { deps: ["T3"] });
  Object.assign(find(items, "T3"), { status: "paused" });
  const found = check(makeModel(items), [{ rule: "status-known" }, { rule: "ids-unique" }], hasAll);
  assert.deepEqual(
    found.map((f) => f.rule),
    ["status-known"],
  );
});
