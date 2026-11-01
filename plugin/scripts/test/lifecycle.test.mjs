// Tests for lib/process/lifecycle.mjs and `board lifecycle` (plan R1b §3.1): each event's writes on a
// synthetic board in a temp git repo, the byte diff limited to the cells and line the lifecycle maps,
// `board check` accepting the result, every step skipped "lifecycle off" without a lifecycle, and
// every refusal writing nothing.
// Run: node --test plugin/scripts/test/lifecycle.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyEvent, renderHandoff } from "../lib/process/lifecycle.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import { WriteError } from "../lib/process/write.mjs";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const SPEC = {
  version: 1,
  name: "Life",
  root: "plan",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      file: {
        glob: "sprints/{id}.md",
        sections: { handoff: { heading: "Handoff", as: "bold-lead" } },
      },
    },
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
        sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
        note: { column: "Note" },
      },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
    },
  },
  rules: [
    { rule: "ids-unique" },
    { rule: "status-known" },
    { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" },
    { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "first" },
  ],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: {
      status: "status",
      verdict: "verdict",
      commit: "commit",
      handoff: "parent.file:handoff",
    },
    handoff: "- **{id}** ({sha}): {summary}",
  },
};
const BOARD_MD = `# Life

## Sprints

| Sprint | Status |
| ------ | ------ |
| S1     | doing  |

## Tasks

| Task | Sprint | Status | Verdict | Commit  | Note        |
| ---- | ------ | ------ | ------- | ------- | ----------- |
| T1   | S1     | verify |         |         | The first   |
| T2   | S1     | todo   |         |         | The second  |
`;
const SPRINT_MD = "# S1\n\n## Handoff\n\n## Notes\n\nNothing yet.\n";

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

/** A temp git repo with the board, the process file and `n` commits; `{ root, shas }`. */
function repo({ spec = SPEC, commits = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentry-life-"));
  temps.push(root);
  mkdirSync(join(root, "plan", "sprints"), { recursive: true });
  mkdirSync(join(root, ".agentry"));
  writeFileSync(join(root, ".agentry", "process.json"), JSON.stringify(spec, null, 2));
  writeFileSync(join(root, "plan", "BOARD.md"), BOARD_MD);
  writeFileSync(join(root, "plan", "sprints", "S1.md"), SPRINT_MD);
  git(root, "init", "-q", "-b", "main");
  const shas = [];
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(root, `f${i}.txt`), `${i}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `change ${i}`);
    shas.push(git(root, "rev-parse", "HEAD"));
  }
  return { root, shas };
}
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const files = (root) => ({
  board: read(root, "plan/BOARD.md"),
  sprint: read(root, "plan/sprints/S1.md"),
});
function event(root, name, id, data) {
  const { spec } = loadSpec(join(root, ".agentry", "process.json"));
  return applyEvent({ root, spec, model: readProcess({ root, spec }), event: name, id, data });
}
const board = (root, ...args) =>
  spawnSync("node", [BOARD, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
// The lines of `after` that differ from `before` (same line count) as [line number, text].
const changed = (before, after) => {
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(a.length, b.length);
  return b.flatMap((line, i) => (line === a[i] ? [] : [[i + 1, line]]));
};
const cells = (line) => line.split("|").map((c) => c.trim());

test("board lifecycle merged writes the status, the a…b commit cell and a handoff line board check accepts", () => {
  const { root, shas } = repo();
  const before = files(root);
  const out = board(
    root,
    "lifecycle",
    "merged",
    "T1",
    "--sha",
    shas[0],
    "--sha",
    shas[1],
    "--summary",
    "first slice landed",
  );
  assert.equal(out.status, 0, out.stderr);
  const [a, b] = shas.map((s) => s.slice(0, 7));
  const now = files(root);
  // BOARD.md: only the T1 row, and in it only the Status and Commit cells.
  const rows = changed(before.board, now.board);
  assert.equal(rows.length, 1);
  const [line, text] = rows[0];
  const was = cells(before.board.split("\n")[line - 1]);
  const is = cells(text);
  const diff = is.flatMap((c, i) => (c === was[i] ? [] : [[i, c]]));
  assert.deepEqual(diff, [
    [3, "done"],
    [5, `${a}…${b}`],
  ]);
  // The sprint file: the one handoff line, inserted under "Handoff", nothing else.
  const handoff = `- **T1** (${a}): first slice landed`;
  assert.equal(now.sprint, before.sprint.replace("## Handoff\n", `## Handoff\n\n${handoff}\n`));
  assert.match(out.stdout, /lifecycle merged T1: 3 written, 0 skipped/);
  const check = board(root, "check");
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("a single landed commit writes one SHA, shortened to 7", () => {
  const { root, shas } = repo({ commits: 1 });
  const result = event(root, "merged", "T1", { shas: shas, summary: "done" });
  assert.deepEqual(
    result.writes.map((w) => [w.file, w.what]),
    [
      ["plan/BOARD.md", "status → done"],
      ["plan/BOARD.md", `commit → ${shas[0].slice(0, 7)}`],
      ["plan/sprints/S1.md", 'handoff line under "Handoff"'],
    ],
  );
  assert.deepEqual(result.skipped, []);
});

test("merging twice writes nothing the second time: every step is skipped as already done", () => {
  const { root, shas } = repo({ commits: 1 });
  event(root, "merged", "T1", { shas, summary: "done" });
  const once = files(root);
  const again = event(root, "merged", "T1", { shas, summary: "done" });
  assert.deepEqual(again.writes, []);
  assert.deepEqual(again.skipped, [
    { what: "status", why: "already set" },
    { what: "commit", why: "already set" },
    { what: "handoff", why: "already there" },
  ]);
  assert.deepEqual(files(root), once);
  const out = board(root, "lifecycle", "merged", "T1", "--sha", shas[0], "--summary", "done");
  assert.match(out.stdout, /0 written, 3 skipped/);
});

test("a handoff line put there since the board was read is not added again", () => {
  const { root, shas } = repo({ commits: 1 });
  const { spec } = loadSpec(join(root, ".agentry", "process.json"));
  const model = readProcess({ root, spec }); // read before the line exists
  const line = `- **T1** (${shas[0].slice(0, 7)}): done`;
  const path = join(root, "plan", "sprints", "S1.md");
  writeFileSync(
    path,
    read(root, "plan/sprints/S1.md").replace("## Handoff\n", `## Handoff\n\n${line}\n`),
  );
  const result = applyEvent({
    root,
    spec,
    model,
    event: "merged",
    id: "T1",
    data: { shas, summary: "done" },
  });
  assert.deepEqual(result.skipped, [{ what: "handoff", why: "already there" }]);
  assert.equal(read(root, "plan/sprints/S1.md").split(line).length - 1, 1);
});

test("a handoff line the done-has-handoff rule would reject for this id is refused, nothing written", () => {
  const { root, shas } = repo();
  // An id the rule reads as two tokens: `leadTokens` splits "**A/B**" at the slash.
  writeFileSync(
    join(root, "plan", "BOARD.md"),
    read(root, "plan/BOARD.md").replace("| T2 ", "| A/B"),
  );
  const before = files(root);
  assert.throws(
    () => event(root, "merged", "A/B", { shas, summary: "x" }),
    (e) => e instanceof WriteError && /would fail rules\[3\] \(done-has-handoff\)/.test(e.message),
  );
  assert.deepEqual(files(root), before);
});

test("a tag object is not a commit SHA", () => {
  const { root, shas } = repo({ commits: 1 });
  git(root, "tag", "-a", "v1", "-m", "v1");
  const tag = git(root, "rev-parse", "v1");
  const before = files(root);
  assert.throws(
    () => event(root, "merged", "T1", { shas: [tag], summary: "x" }),
    (e) => e instanceof WriteError && /is not a commit in git/.test(e.message),
  );
  assert.deepEqual(files(root), before);
  assert.ok(event(root, "merged", "T1", { shas, summary: "x" }).writes.length);
});

test("a written prefix is unique across every object type: it grows past a shared one", () => {
  const { root, shas } = repo({ commits: 1 });
  const sha = shas[0];
  // A loose object that is not the commit but shares its first 7 characters.
  const dir = join(root, ".git", "objects", sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha.slice(2, 7)}${"f".repeat(33)}`), "");
  event(root, "merged", "T1", { shas: [sha], summary: "x" });
  const cell = cells(
    read(root, "plan/BOARD.md")
      .split("\n")
      .find((l) => l.startsWith("| T1")),
  )[5];
  assert.equal(cell, sha.slice(0, 8));
  assert.match(read(root, "plan/sprints/S1.md"), new RegExp(`\\(${sha.slice(0, 8)}\\)`));
});

test("dispatched, built and failed write the status `on` maps them to", () => {
  const { root } = repo();
  const status = () =>
    cells(
      read(root, "plan/BOARD.md")
        .split("\n")
        .find((l) => l.startsWith("| T2")),
    )[3];
  for (const [name, word] of [
    ["dispatched", "doing"],
    ["built", "verify"],
    ["failed", "doing"],
  ]) {
    const result = event(root, name, "T2");
    assert.deepEqual(result.writes, [{ file: "plan/BOARD.md", what: `status → ${word}` }]);
    assert.equal(status(), word);
  }
});

test("a pass writes the verdict and leaves the status; FAIL also applies failed", () => {
  const { root } = repo();
  const row = () =>
    cells(
      read(root, "plan/BOARD.md")
        .split("\n")
        .find((l) => l.startsWith("| T1")),
    );
  const pass = event(root, "verdict", "T1", { verdict: "PASS WITH NOTES" });
  assert.deepEqual(
    pass.writes.map((w) => w.what),
    ["verdict → PASS WITH NOTES"],
  );
  assert.deepEqual([row()[3], row()[4]], ["verify", "PASS WITH NOTES"]);
  const fail = event(root, "verdict", "T1", { verdict: "FAIL" });
  assert.deepEqual(
    fail.writes.map((w) => w.what),
    ["verdict → FAIL", "status → doing"],
  );
  assert.deepEqual([row()[3], row()[4]], ["doing", "FAIL"]);
});

test("with no lifecycle every event writes nothing and reports each step skipped: lifecycle off", () => {
  const spec = structuredClone(SPEC);
  Reflect.deleteProperty(spec, "lifecycle");
  const { root, shas } = repo({ spec });
  const before = files(root);
  const cases = [
    ["dispatched", {}, ["status"]],
    ["built", {}, ["status"]],
    ["failed", {}, ["status"]],
    ["verdict", { verdict: "PASS" }, ["verdict"]],
    ["verdict", { verdict: "FAIL" }, ["verdict", "status"]],
    ["merged", { shas, summary: "x" }, ["status", "commit", "handoff"]],
  ];
  for (const [name, data, steps] of cases) {
    const result = event(root, name, "T1", data);
    assert.deepEqual(result, {
      writes: [],
      skipped: steps.map((what) => ({ what, why: "lifecycle off" })),
    });
  }
  const cli = board(root, "lifecycle", "built", "T1");
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /0 written, 1 skipped\n {2}skipped status: lifecycle off/);
  assert.deepEqual(files(root), before);
});

test("a step the lifecycle does not map is skipped, naming the missing key", () => {
  const spec = structuredClone(SPEC);
  Reflect.deleteProperty(spec.lifecycle.on, "built");
  Reflect.deleteProperty(spec.lifecycle.write, "verdict");
  const { root } = repo({ spec });
  assert.deepEqual(event(root, "built", "T1").skipped, [
    { what: "status", why: "no lifecycle.on.built" },
  ]);
  assert.deepEqual(event(root, "verdict", "T1", { verdict: "PASS" }).skipped, [
    { what: "verdict", why: "no lifecycle.write.verdict" },
  ]);
});

test("every refusal is exit 2 and writes nothing", () => {
  const { root, shas } = repo();
  const before = files(root);
  const cases = [
    [["lifecycle", "landed", "T1"], /unknown event "landed"/],
    [["lifecycle", "verdict", "T1", "--verdict", "OK"], /verdict needs one of "PASS"/],
    [["lifecycle", "verdict", "T1"], /verdict needs one of/],
    [["lifecycle", "built", "T1", "--sha", shas[0]], /built takes no "shas"/],
    [["lifecycle", "merged", "T1", "--summary", "x"], /merged needs the landed commits/],
    [
      ["lifecycle", "merged", "T1", "--sha", "xyz1234", "--summary", "x"],
      /"xyz1234" is not a commit SHA/,
    ],
    [
      ["lifecycle", "merged", "T1", "--sha", shas[0].toUpperCase(), "--summary", "x"],
      /is not a commit SHA \(7 to 40 lower-case hex\)/,
    ],
    [
      ["lifecycle", "merged", "T1", "--sha", "0000000000", "--summary", "x"],
      /0000000000 is not a commit in git/,
    ],
    [["lifecycle", "merged", "T1", "--sha", shas[0]], /needs a summary/],
    [
      ["lifecycle", "merged", "T9", "--sha", shas[0], "--summary", "x"],
      /no task "T9" on the board/,
    ],
    [["lifecycle", "built"], /usage: lifecycle/],
    [["lifecycle", "built", "T1", "--summary", "a", "--summary", "b"], /--summary is given twice/],
    [["lifecycle", "built", "T1", "--sha"], /--sha needs a value/],
    [["lifecycle", "built", "T1", "--shas", "x"], /unknown option "--shas"/],
  ];
  for (const [argv, re] of cases) {
    const out = board(root, ...argv);
    assert.equal(out.status, 2, `${argv.join(" ")}: ${out.stdout}`);
    assert.match(out.stderr, re, argv.join(" "));
  }
  assert.deepEqual(files(root), before);
});

test("a handoff with no parent file refuses the whole event: the status is not written either", () => {
  const { root, shas } = repo();
  rmSync(join(root, "plan", "sprints", "S1.md"));
  const board_ = read(root, "plan/BOARD.md");
  assert.throws(
    () => event(root, "merged", "T1", { shas, summary: "x" }),
    (e) => e instanceof WriteError && /sprint S1 has no file/.test(e.message),
  );
  assert.equal(read(root, "plan/BOARD.md"), board_);
});

test("a one-file-per-item kind gets its frontmatter key written", () => {
  const spec = {
    version: 1,
    name: "Files",
    root: ".",
    kinds: {
      story: {
        label: "Story",
        at: { files: "stories/*.md", id: "frontmatter:id" },
        fields: { state: { column: "state" } },
        status: { field: "state", values: { open: "planned", doing: "active", shipped: "done" } },
      },
    },
    rules: [],
    lifecycle: { kind: "story", on: { dispatched: "doing" }, write: { status: "state" } },
  };
  const root = mkdtempSync(join(tmpdir(), "agentry-life-"));
  temps.push(root);
  mkdirSync(join(root, "stories"));
  writeFileSync(join(root, "stories", "s1.md"), "---\nid: S-1\nstate: open\n---\n\n# One\n");
  const model = readProcess({ root, spec });
  const result = applyEvent({ root, spec, model, event: "dispatched", id: "S-1" });
  assert.deepEqual(result.writes, [{ file: "stories/s1.md", what: "state → doing" }]);
  assert.equal(read(root, "stories/s1.md"), "---\nid: S-1\nstate: doing\n---\n\n# One\n");
});

test("renderHandoff fills id, sha and summary, each on one line", () => {
  assert.equal(
    renderHandoff(SPEC, { id: "T4", sha: "abc1234", summary: "two\n  lines" }),
    "- **T4** (abc1234): two lines",
  );
  assert.throws(
    () => renderHandoff({ lifecycle: { kind: "t", on: {} } }, { id: "T4" }),
    WriteError,
  );
});
