// Tests for lib/process/steps.mjs (a contract's Steps part, field 48) and the steps `findContract` adds
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

// Field 96a: the steps in one wrapped paragraph after the label.
const INLINE = `- **T1** · Two parts
- **Owns:** \`a.txt\`
- **Steps:** 1. Write the parser → owner OK 2. Wire it into the CLI
  and print the result -> Owner ok. 3. Ship it
- **Acceptance:**
  - Step 1: the parser test passes
  - step 3: the release note says so
  - the whole suite is green
- **Deps:** none`;

test("inline steps after the label parse into the same steps as one per line, gates and all", () => {
  assert.deepEqual(stepsOf(INLINE), stepsOf(BULLETS));
});

test("a number inside an inline step's text is not a split: only the next number in order splits", () => {
  const block = "**Steps:** 1. Wait 2.5 s for v1. x, then 3. retry 2. Check 1. again 3. Ship";
  assert.deepEqual(
    stepsOf(block).steps.map((s) => s.text),
    ["Wait 2.5 s for v1. x, then 3. retry", "Check 1. again", "Ship"],
  );
});

test("the inline paragraph ends at its first blank line", () => {
  const block =
    "- **Steps:** 1. One 2. Two\n\n  Prose about the steps 3. not a step\n- **Deps:** none";
  assert.deepEqual(
    stepsOf(block).steps.map((s) => [s.n, s.text]),
    [
      [1, "One"],
      [2, "Two"],
    ],
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
  assert.deepEqual(stepsOf("**Steps:** 1. A (model: opus) 2. B (agent: designer)").steps, [
    { n: 1, text: "A", gate: null, accept: [], model: "opus" },
    { n: 2, text: "B", gate: null, accept: [], agent: "designer" },
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
    "# Tasks\n\n- **T1**: owns `y`.\n  - **Steps:**\n    1. a\n    3. c\n\n- **T2**: owns `z`.\n  - **Steps:** 1. a 2. b\n",
  );
  git(dir, "add", "TASKS.md");
  git(dir, "commit", "-qm", "tasks");
  const ready = rules.find((r) => r.id === "ready-has-contract");
  const model = makeModel([
    sprint("S1", "doing"),
    task("T1", "S1", "todo"),
    task("T2", "S1", "todo"),
  ]);
  const ctx = { contractOf: (_kind, id) => findContract({ root: dir, id }) };
  assert.deepEqual(
    run(ready, model, { kind: "task" }, ctx).map((f) => [f.id, f.message]),
    [["T1", "contract T1: steps must be numbered 1 to N with no gap (found 1, 3)"]],
  );
});

test("steps built in one round that name different models or agents are a problem", () => {
  assert.equal(
    stepsOf("- **Steps:**\n  1. a (model: opus)\n  2. b\n  3. c (model: sonnet)").problem,
    "steps 1 and 3 are built in one round but name different models (opus, sonnet): put an owner gate between them or name one model",
  );
  assert.equal(
    stepsOf("**Steps:** 1. a (agent: designer) 2. b (agent: implementer)").problem,
    "steps 1 and 2 are built in one round but name different agents (designer, implementer): put an owner gate between them or name one agent",
  );
  // Separate runs (an owner gate between) and markers that agree are fine.
  assert.equal(
    stepsOf("**Steps:** 1. a (model: opus) → owner OK 2. b (model: sonnet)").problem,
    null,
  );
  assert.equal(
    stepsOf("**Steps:** 1. a (model: opus) 2. b (model: opus, agent: designer)").problem,
    null,
  );
});

test("runMark: the run's first step naming the key, as step N; null without a run or a marked step", () => {
  const { steps } = stepsOf(
    "**Steps:** 1. a 2. b (model: opus) 3. c (model: opus) → owner OK 4. d",
  );
  assert.deepEqual(runMark(steps, [1, 3], "model"), { value: "opus", from: "step 2" });
  assert.equal(runMark(steps, [4, 4], "model"), null);
  assert.equal(runMark(steps, [1, 3], "agent"), null);
  assert.equal(runMark(steps, null, "model"), null);
  assert.equal(runMark([], [1, 1], "model"), null);
});

// Round 3's review: a code span, a paragraph that ends early, bold at a wrap, and marker spelling.
test("a number inside a code span never splits an inline step, so its owner gate stays", () => {
  const { steps, problem } = stepsOf(
    "- **Steps:** 1. Run `make 2. x` → owner OK 2. Wire (agent: designer)",
  );
  assert.equal(problem, null);
  assert.deepEqual(steps, [
    { n: 1, text: "Run `make 2. x`", gate: "owner", accept: [] },
    { n: 2, text: "Wire", gate: null, accept: [], agent: "designer" },
  ]);
  assert.deepEqual(runOf(steps, 1), [1, 1]);
});

test("a numbered line left in the Steps part after the inline paragraph is a problem, never dropped", () => {
  const problem = (left) =>
    `a numbered line follows the inline steps' paragraph (${left}): keep the steps in one paragraph or put one per line`;
  assert.equal(
    stepsOf("**Steps:** 1. One\n\n2. Two\n3. Three\n- **Deps:** none").problem,
    problem("2. Two"),
  );
  assert.equal(
    stepsOf("- **Steps:** 1. a\n  ```\n  2. code\n  ```\n  3. after").problem,
    problem("3. after"),
  );
});

test("a wrapped inline line that starts with bold text continues the paragraph; a labelled part ends it", () => {
  assert.deepEqual(
    stepsOf("- **Steps:** 1. Write the\n  **parser** now 2. Ship\n- **Deps:** none").steps.map(
      (s) => s.text,
    ),
    ["Write the **parser** now", "Ship"],
  );
  assert.deepEqual(
    stepsOf("- **Steps:** 1. One 2. Two\n- **Deps**: 3. not a step").steps.map((s) => s.text),
    ["One", "Two"],
  );
});

test("marker keys and values are read in any case, in lower case", () => {
  const { steps, problem } = stepsOf(
    "**Steps:** 1. a (Model: Opus) 2. b (MODEL: opus, Agent: Designer)",
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

// Round 5's review: code spans as CommonMark reads them, the gate backstop, and list items after the paragraph.
test("inline and one per line parse alike around escaped, doubled, lone and balanced backticks", () => {
  const cases = {
    escaped: ["Print the \\` char → owner OK", "Ship", "Deploy"],
    doubleSpan: ["Run ``a ` b`` now → owner OK", "Ship", "Deploy"],
    literal: ["Press the ` key → owner OK", "Ship", "Deploy"],
    balanced: ["Run `make 2. x` → owner OK", "Ship", "Deploy"],
  };
  for (const [name, items] of Object.entries(cases)) {
    const inline = stepsOf(`- **Steps:** ${items.map((t, i) => `${i + 1}. ${t}`).join(" ")}`);
    const lines = stepsOf(`- **Steps:**\n${items.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`);
    assert.deepEqual(inline, lines, name);
    assert.equal(inline.steps[0].gate, "owner", name);
  }
});

test("a number inside a double-backtick span splits nothing; a span closed earlier lets the next split through", () => {
  assert.deepEqual(
    stepsOf("**Steps:** 1. Run ``a ` b 2. c`` now 2. Ship").steps.map((s) => s.text),
    ["Run ``a ` b 2. c`` now", "Ship"],
  );
  assert.deepEqual(
    stepsOf("**Steps:** 1. Run `make` → owner OK 2. Wire `x 3. y` 3. Ship").steps.map((s) => [
      s.text,
      s.gate,
    ]),
    [
      ["Run `make`", "owner"],
      ["Wire `x 3. y`", null],
      ["Ship", null],
    ],
  );
});

test("an inline step still holding an owner gate mid-text is a problem naming the step", () => {
  assert.equal(
    stepsOf("- **Steps:** 1. Build → owner OK then tidy 2. Ship").problem,
    "step 1 holds an owner gate mid-text: put each step on its own line",
  );
  // One per line keeps today's reading: the gate is the item's end or nothing.
  assert.equal(stepsOf("- **Steps:**\n  1. Build → owner OK then tidy\n  2. Ship").problem, null);
});

test("a list item at or left of the label's indent ends the inline paragraph, so a step's marker holds", () => {
  for (const next of ["- **Note** keep it small", "- Deps: none", "* later", "+ later"])
    assert.deepEqual(
      stepsOf(`- **Steps:** 1. a 2. b (model: opus)\n${next}`).steps.at(-1),
      { n: 2, text: "b", gate: null, accept: [], model: "opus" },
      next,
    );
  assert.equal(
    stepsOf("**Steps:** 1. a\n2. b").problem,
    "a numbered line follows the inline steps' paragraph (2. b): keep the steps in one paragraph or put one per line",
  );
  // A more indented line still wraps the paragraph, a number at its start included.
  assert.deepEqual(
    stepsOf("- **Steps:** 1. a\n  2. b").steps.map((s) => s.text),
    ["a", "b"],
  );
});
