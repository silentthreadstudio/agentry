// Tests that a commit written in upper case on a board is still read by the evidence rules, the status
// prefetch and the handoff check, while the board reader's `commits` cell stays lower-case only.
// Run: node --test plugin/scripts/test/sha-case.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseCommits } from "../lib/process/markdown.mjs";
import { readProcess } from "../lib/process/read.mjs";
import { namesCommits } from "../lib/process/rules/evidence.mjs";
import { boardReport } from "../lib/process/status.mjs";
import { commitFile, tempRepo } from "./git-repo.mjs";

const repo = tempRepo();
after(repo.cleanup);

test("an evidence cell holding the commit in upper case is a commit that git has", () => {
  const sha = commitFile(repo.dir, "a.txt", "a\n");
  const up = sha.slice(0, 7).toUpperCase();
  const rows = [
    `| T1 | done | ${up} |`,
    `| T2 | done | ${sha.slice(0, 7)} abc1234x |`,
    `| T3 | done | ${sha.slice(0, 7)} ${"D".repeat(7)} |`,
  ];
  const text = ["## Tasks", "", "| Task | Status | Evidence |", "| --- | --- | --- |", ...rows, ""];
  writeFileSync(join(repo.dir, "BOARD.md"), text.join("\n"));
  const task = {
    label: "Task",
    at: { table: "BOARD.md", heading: "Tasks" },
    id: { column: "Task" },
    fields: { status: { column: "Status" }, evidence: { column: "Evidence", type: "evidence" } },
    status: { field: "status", values: { done: "done" } },
  };
  const rules = [
    { rule: "done-has-evidence", kind: "task", field: "evidence", evidence: "commit" },
  ];
  const spec = { version: 1, name: "P", root: ".", kinds: { task }, rules };
  const model = readProcess({ root: repo.dir, spec });
  const found = boardReport({ root: repo.dir, spec, model }).findings;
  assert.deepEqual(
    found.map((f) => f.id),
    ["T3"],
    "T1 passes; only the missing DDDDDDD is reported",
  );
  assert.match(found[0].message, /commit DDDDDDD is not in git/);
});

// Git ids are case-insensitive. The first version of this check compared case-sensitively and reported
// "names no matching commit" for `(ABC1234)` against `abc1234`, which was a false finding.
test("a handoff line names a commit in either case", () => {
  const lead = (sha) => [{ lead: "**T1**", text: `**T1** (${sha}) done` }];
  const full = "1b72454aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(namesCommits(lead("1B72454"), [full], "first"), true);
  assert.equal(namesCommits(lead("1b72454"), [full.toUpperCase()], "first"), true);
});

test("the board's commits cell stays lower-case only", () => {
  assert.deepEqual(parseCommits("1B72454 1b72454"), ["1b72454"]);
});
