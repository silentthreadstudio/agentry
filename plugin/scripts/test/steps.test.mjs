// Tests for lib/process/steps.mjs (a contract's Steps part, field 48) and the steps `findContract` adds
// to a found result.
// Run: node --test plugin/scripts/test/steps.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { findContract } from "../lib/process/contract.mjs";
import { runOf, runText, stepsOf } from "../lib/process/steps.mjs";
import { git, tempRepo } from "./git-repo.mjs";

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
