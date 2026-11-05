// Tests for lib/process/steps.mjs (a contract's Steps part) and the steps `findContract` adds
// to a found result.
// Run: node --test plugin/scripts/test/steps.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { findContract } from "../lib/process/contract.mjs";
import { rules } from "../lib/process/rules/flow.mjs";
import { runMark, runOf, runText, stepsOf } from "../lib/process/steps.mjs";
import { git, tempRepo } from "./git-repo.mjs";
import { makeModel, run, sprint, task } from "./rules-model.mjs";

const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});

const BULLETS = `- **T1** · Two parts
- **Owns:** \`a.txt\`
- **Steps:**
  1. Write the parser → owner OK
  2) Wire it into the CLI
     and print the result -> Owner ok.
  3. Ship it
- **Acceptance:**
  - Step 1: the parser test passes
  - step 3: the release note says so
  - the whole suite is green
- **Deps:** none`;

test("the bullet form: numbered items, both arrows in any case, an indented line joined", () => {
  assert.deepEqual(stepsOf(BULLETS), {
    steps: [
      { n: 1, text: "Write the parser", gate: "owner", accept: ["the parser test passes"] },
      { n: 2, text: "Wire it into the CLI and print the result", gate: "owner", accept: [] },
      { n: 3, text: "Ship it", gate: null, accept: ["the release note says so"] },
    ],
    problem: null,
  });
});

test("the heading form: a Steps heading of any level, ended by the next heading", () => {
  const block = [
    "## T2 · Headings",
    "",
    "#### Steps",
    "",
    "1. One thing",
    "2. Another → owner ok",
    "",
    "#### Acceptance",
    "",
    "- Step 2: another is seen",
    "- untagged",
  ].join("\n");
  assert.deepEqual(stepsOf(block).steps, [
    { n: 1, text: "One thing", gate: null, accept: [] },
    { n: 2, text: "Another", gate: "owner", accept: ["another is seen"] },
  ]);
  assert.deepEqual(stepsOf("**Steps**:\n1. Only\n**Accept:** x").steps, [
    { n: 1, text: "Only", gate: null, accept: [] },
  ]);
});

test("each problem, exactly", () => {
  assert.equal(
    stepsOf("- **Steps:**\n  1. a\n  3. c").problem,
    "steps must be numbered 1 to N with no gap (found 1, 3)",
  );
  assert.equal(
    stepsOf("- **Steps:** later\n- **Owns:** `a`").problem,
    "the Steps part has no numbered items, one per line",
  );
  assert.equal(
    stepsOf("- **Steps:**\n  1. a\n  2. b\n- **Acceptance:**\n  - Step 3: c").problem,
    "acceptance names step 3; the contract has 2 steps",
  );
});

test("no Steps part: no steps and no problem, whatever the acceptance tags", () => {
  assert.deepEqual(stepsOf("- **T1**: owns `a.txt`. **Acceptance:**\n- Step 1: x"), {
    steps: [],
    problem: null,
  });
  assert.deepEqual(stepsOf("- **Steps in a contract.** prose, not a part"), {
    steps: [],
    problem: null,
  });
});

test("runOf ends a run at the first owner gate from its start, else the last step; runText names it", () => {
  const { steps } = stepsOf(BULLETS);
  assert.deepEqual(runOf(steps, 1), [1, 1]);
  assert.deepEqual(runOf(steps, 3), [3, 3]);
  assert.deepEqual(runOf(stepsOf("**Steps:**\n1. a\n2. b\n3. c").steps, 1), [1, 3]);
  assert.equal(runText([1, 1], 2), "step 1 of 2");
  assert.equal(runText([2, 3], 3), "steps 2–3 of 3");
});

test("findContract adds steps only to a block that has a Steps part", () => {
  const { dir, cleanup } = tempRepo();
  cleanups.push(cleanup);
  const plain = "- **T9**: owns `x.txt`. Accept: x.txt exists.";
  writeFileSync(join(dir, "TASKS.md"), `# Tasks\n\n${plain}\n\n${BULLETS}\n`);
  git(dir, "add", "TASKS.md");
  git(dir, "commit", "-qm", "tasks");
  assert.deepEqual(findContract({ root: dir, id: "T9" }), {
    status: "found",
    id: "T9",
    file: "TASKS.md",
    line: 3,
    source: "discovered",
    block: plain,
  });
  const found = findContract({ root: dir, id: "T1" });
  assert.deepEqual(
    found.steps.map((s) => s.n),
    [1, 2, 3],
  );
  assert.equal(found.stepsProblem, undefined);
  writeFileSync(
    join(dir, "TASKS.md"),
    "# Tasks\n\n- **T3**: owns `y`.\n  - **Steps:**\n    1. a\n    3. c\n",
  );
  git(dir, "commit", "-qam", "gap");
  assert.equal(
    findContract({ root: dir, id: "T3" }).stepsProblem,
    "steps must be numbered 1 to N with no gap (found 1, 3)",
  );
});

test("a bold run indented under a step is its text, not a label that ends the part", () => {
  const block =
    "- **Steps:**\n  1. First\n     **careful** with this\n  2. Second\n- **Deps:** none";
  assert.deepEqual(stepsOf(block), {
    steps: [
      { n: 1, text: "First **careful** with this", gate: null, accept: [] },
      { n: 2, text: "Second", gate: null, accept: [] },
    ],
    problem: null,
  });
  const heading = "### Steps\n\n1. First\n   **careful** with this\n2. Second\n**Accept:** x";
  assert.deepEqual(
    stepsOf(heading).steps.map((s) => s.n),
    [1, 2],
  );
});

// Field 96a: steps listed inline after the label are flagged with a rewrite, never parsed.
const INLINE = `- **T1** · Two parts
- **Owns:** \`a.txt\`
- **Steps:** 1. Write the parser → owner OK 2. Wire it into the CLI
  and print the result -> Owner ok. 3. Ship it (model: opus)
- **Acceptance:**
  - Step 1: the parser test passes
- **Deps:** none`;
const flagged = (...lines) =>
  [
    "the Steps part lists its steps inline: put each step on its own line",
    ...lines.map((l) => `  ${l}`),
  ].join("\n");

test("inline steps are a problem with no steps, its rewrite one step per line, gates and markers as written", () => {
  assert.deepEqual(stepsOf(INLINE), {
    steps: [],
    problem: flagged(
      "1. Write the parser → owner OK",
      "2. Wire it into the CLI and print the result -> Owner ok.",
      "3. Ship it (model: opus)",
    ),
  });
});

test("the rewrite cuts only at the next number in order and never inside a code span", () => {
  assert.equal(
    stepsOf("**Steps:** 1. Wait 2.5 s, then 3. retry 2. Run `make 3. x` (agent: designer) 3. Ship")
      .problem,
    flagged("1. Wait 2.5 s, then 3. retry", "2. Run `make 3. x` (agent: designer)", "3. Ship"),
  );
  assert.equal(stepsOf("**Steps:** 1. Only one").problem, flagged("1. Only one"));
});

test("the rewrite takes the label's paragraph: a blank line or a list item at the label's indent ends it", () => {
  assert.equal(stepsOf("- **Steps:** 1. a 2. b\n- Deps: none").problem, flagged("1. a", "2. b"));
  assert.equal(stepsOf("- **Steps:** 1. a\n\n  2. b").problem, flagged("1. a"));
});

test("only `1. ` on the label's own line is the inline form: a heading or a later line parses as today", () => {
  assert.deepEqual(stepsOf("## Steps\n1. a 2. b").steps, [
    { n: 1, text: "a 2. b", gate: null, accept: [] },
  ]);
  assert.equal(stepsOf("**Steps:** in order\n1. a\n2. b").problem, null);
});

test("a number inside a one-per-line step's text never splits it", () => {
  assert.deepEqual(
    stepsOf(
      "- **Steps:**\n  1. Wait 2.5 s for v1. x, then 2. retry\n  2. Run `make 3. x`",
    ).steps.map((s) => s.text),
    ["Wait 2.5 s for v1. x, then 2. retry", "Run `make 3. x`"],
  );
});

test("a step's (model, agent) marker is cut from its end, before or after the gate", () => {
  const block = [
    "- **Steps:**",
    "  1. Build the parser (model: opus, agent: implementer) → owner OK",
    "  2. Draw the panel → owner OK (agent: designer)",
    "  3. Ship it (Model: `haiku`)",
    "  4. Tidy (see notes)",
  ].join("\n");
  assert.deepEqual(stepsOf(block).steps, [
    {
      n: 1,
      text: "Build the parser",
      gate: "owner",
      accept: [],
      model: "opus",
      agent: "implementer",
    },
    { n: 2, text: "Draw the panel", gate: "owner", accept: [], agent: "designer" },
    { n: 3, text: "Ship it", gate: null, accept: [], model: "haiku" },
    { n: 4, text: "Tidy (see notes)", gate: null, accept: [] },
  ]);
});

test("a step naming an agent other than designer or implementer is a problem", () => {
  assert.equal(
    stepsOf("- **Steps:**\n  1. a\n  2. b (agent: verifier)").problem,
    "step 2 names agent verifier; a step's agent is designer or implementer",
  );
});

test("the Ready rule flags a found contract whose Steps part has a problem, in exec start's words", () => {
  const { dir, cleanup } = tempRepo();
  cleanups.push(cleanup);
  writeFileSync(
    join(dir, "TASKS.md"),
    "# Tasks\n\n- **T1**: owns `y`.\n  - **Steps:**\n    1. a\n    3. c\n\n- **T2**: owns `z`.\n  - **Steps:** 1. a → owner OK 2. b\n\n- **T3**: owns `w`.\n  - **Steps:**\n    1. a\n",
  );
  git(dir, "add", "TASKS.md");
  git(dir, "commit", "-qm", "tasks");
  const ready = rules.find((r) => r.id === "ready-has-contract");
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "todo"),
    task("T2", "S1", "todo"),
    task("T3", "S1", "todo"),
  ]);
  const ctx = { contractOf: (_kind, id) => findContract({ root: dir, id }) };
  assert.deepEqual(
    run(ready, model, { kind: "task" }, ctx).map((f) => [f.id, f.message]),
    [
      ["T1", "contract T1: steps must be numbered 1 to N with no gap (found 1, 3)"],
      ["T2", `contract T2: ${flagged("1. a → owner OK", "2. b")}`],
    ],
  );
});

test("steps built in one round that name different models or agents are a problem", () => {
  const steps = (...items) => `- **Steps:**\n${items.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`;
  assert.equal(
    stepsOf(steps("a (model: opus)", "b", "c (model: sonnet)")).problem,
    "steps 1 and 3 are built in one round but name different models (opus, sonnet): put an owner gate between them or name one model",
  );
  assert.equal(
    stepsOf(steps("a (agent: designer)", "b (agent: implementer)")).problem,
    "steps 1 and 2 are built in one round but name different agents (designer, implementer): put an owner gate between them or name one agent",
  );
  // Separate runs (an owner gate between) and markers that agree are fine.
  assert.equal(stepsOf(steps("a (model: opus) → owner OK", "b (model: sonnet)")).problem, null);
  assert.equal(stepsOf(steps("a (model: opus)", "b (model: opus, agent: designer)")).problem, null);
});

test("runMark: the run's first step naming the key, as step N; null without a run or a marked step", () => {
  const { steps } = stepsOf(
    "- **Steps:**\n  1. a\n  2. b (model: opus)\n  3. c (model: opus) → owner OK\n  4. d",
  );
  assert.deepEqual(runMark(steps, [1, 3], "model"), { value: "opus", from: "step 2" });
  assert.equal(runMark(steps, [4, 4], "model"), null);
  assert.equal(runMark(steps, [1, 3], "agent"), null);
  assert.equal(runMark(steps, null, "model"), null);
  assert.equal(runMark([], [1, 1], "model"), null);
});

test("marker keys and values are read in any case, in lower case", () => {
  const { steps, problem } = stepsOf(
    "- **Steps:**\n  1. a (Model: Opus)\n  2. b (MODEL: opus, Agent: Designer)",
  );
  assert.equal(problem, null);
  assert.deepEqual(
    steps.map((s) => [s.model, s.agent]),
    [
      ["opus", undefined],
      ["opus", "designer"],
    ],
  );
});

test("a marker value with a space is a problem naming the step", () => {
  assert.equal(
    stepsOf("- **Steps:**\n  1. a\n  2. b (model: opus agent: designer)").problem,
    `step 2's marker names model "opus agent: designer": a marker value is one word, and its keys are split by a comma`,
  );
});

const gateOf = (text) => stepsOf(`- **Steps:**\n  1. ${text}\n  2. Ship it`).steps[0];

for (const [spelling, text] of [
  ["a unicode arrow", "Draw it → owner OK"],
  ["an ascii arrow", "Draw it -> owner OK"],
  ["an em dash", "Draw it — owner OK"],
  ["an en dash", "Draw it – owner OK"],
  ["a bold gate", "Draw it → **owner OK**"],
  ["any case and a period", "Draw it. → OWNER ok."],
]) {
  test(`the gate spelled with ${spelling} is a gate`, () => {
    assert.deepEqual(gateOf(text), {
      n: 1,
      text: text.slice(0, text.search(/\s*[→–—]|\s*->/)).trim(),
      gate: "owner",
      accept: [],
    });
  });
}

test("a gate's (note) is kept as the note, not read as a marker", () => {
  assert.deepEqual(gateOf("Draw it → owner OK (the sprite sheet in the lab)"), {
    n: 1,
    text: "Draw it",
    gate: "owner",
    accept: [],
    note: "the sprite sheet in the lab",
  });
});

test("a note and a marker together: the marker is still a marker, either order", () => {
  const a = gateOf("Draw it → owner OK (see sheet) (model: opus)");
  assert.deepEqual([a.gate, a.note, a.model], ["owner", "see sheet", "opus"]);
  const b = gateOf("Draw it (agent: designer) → **owner OK** (see sheet)");
  assert.deepEqual(
    [b.gate, b.note, b.agent, b.text],
    ["owner", "see sheet", "designer", "Draw it"],
  );
  const c = gateOf("Draw it → owner OK (model: opus, agent: designer)");
  assert.deepEqual([c.gate, c.note, c.model, c.agent], ["owner", undefined, "opus", "designer"]);
});

test("a step that names the owner gate but does not parse as one is a problem naming the step", () => {
  const problem = (text) => stepsOf(`- **Steps:**\n  1. Build it\n  2. ${text}`).problem;
  const want = `step 2 mentions an owner gate but does not end with "→ owner OK": write it as "… → owner OK"`;
  for (const text of [
    "Draw it → owner review",
    "Owner OK before step 3.",
    "Draw it, then the owner approves",
    "Stop at the owner gate",
    "Draw it → owner OK then ship",
    "Draw it → owner reviews",
    "Draw it → owner okay",
    "Draw it → owners OK",
  ])
    assert.equal(problem(text), want, text);
});

test("a step that names the owner in prose without OK, review, approves or gate is unchanged", () => {
  const { steps, problem } = stepsOf(
    "- **Steps:**\n  1. Ask the owner's name\n  2. Okay, the okapi",
  );
  assert.equal(problem, null);
  assert.deepEqual(
    steps.map((s) => s.gate),
    [null, null],
  );
});

test("each inflection of a gate word beside the owner is the problem", () => {
  for (const text of [
    "Draw it → owner reviewed",
    "Draw it → owner approve",
    "Draw it → owner approved",
    "Draw it → owner approval",
    "Draw it → owner sign-off",
    "Draw it → the owner signs off",
    "Draw it → the owner signed off",
  ])
    assert.match(
      stepsOf(`- **Steps:**\n  1. ${text}`).problem,
      /^step 1 mentions an owner gate/,
      text,
    );
});
