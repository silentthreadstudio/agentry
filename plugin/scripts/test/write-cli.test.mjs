// Tests for lib/process/cli/{add,set}.mjs — called directly: run(argv, { root, spec, model }) -> { exit, out }.
// Fixtures (invented): write (aligned tables, a block under a templated heading, a parent file),
// table-board and frontmatter-board (copied to a scratch dir, never edited in place).
// Run: node --test plugin/scripts/test/write-cli.test.mjs
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "../lib/process/check.mjs";
import { run as add } from "../lib/process/cli/add.mjs";
import { run as set } from "../lib/process/cli/set.mjs";
import { findContract } from "../lib/process/contract.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TEMPLATES = join(FIXTURES, "..", "..", "..", "skills", "process", "templates");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function copy(name) {
  const root = mkdtempSync(join(tmpdir(), "agentry-cli-"));
  temps.push(root);
  cpSync(join(FIXTURES, name), root, { recursive: true });
  return root;
}
/** Run a CLI against the current state of a scratch board (the model is read fresh, as the router does). */
function call(cli, root, argv, extra = {}) {
  const { spec } = loadSpec(join(root, "process.json"));
  return cli(argv, {
    root,
    spec,
    model: readProcess({ root, spec }),
    today: "2026-05-01",
    ...extra,
  });
}
const text = (root, rel) => readFileSync(join(root, rel), "utf8");
const addTask = (root, fields, kind = "task") =>
  call(add, root, [kind, "--fields", JSON.stringify(fields), "--apply"]);
const findings = (root) => {
  const { spec } = loadSpec(join(root, "process.json"));
  const model = readProcess({ root, spec });
  const ctx = {
    hasCommit: () => true,
    contractOf: (kind, id) => findContract({ root, spec, id, kind }),
  };
  return check(model, spec.rules, ctx).map((f) => `${f.rule}|${f.id}|${f.message}`);
};

test("without --apply, add and set print what they would write and change nothing", () => {
  const root = copy("write");
  const before = ["board/BOARD.md", "board/TASKS.md", "board/sprints/A1_one.md"].map((f) =>
    text(root, f),
  );
  const added = call(add, root, ["task", "--fields", '{"id":"W4","sprint":"A1","note":"Fourth"}']);
  assert.equal(added.exit, 0, added.out);
  assert.match(added.out, /^would add task W4\n/);
  assert.match(added.out, /\n {2}BOARD\.md:\n {4}\+ \| W4 \| A1 \| todo \|/);
  assert.match(added.out, /\npreview: nothing written; add --apply to write it$/);
  const cell = call(set, root, ["task", "W3", "status=doing"]);
  assert.equal(cell.exit, 0, cell.out);
  assert.match(cell.out, /^would set task W3 status=doing \(BOARD\.md\)\npreview: /);
  const now = ["board/BOARD.md", "board/TASKS.md", "board/sprints/A1_one.md"].map((f) =>
    text(root, f),
  );
  assert.deepEqual(now, before);
  // A preview refuses what the write would refuse.
  assert.equal(call(add, root, ["task", "--fields", '{"id":"W1","sprint":"A1"}']).exit, 2);
});

test("add writes the row after the sprint's last row, the sprint file row and the templated block", () => {
  const root = copy("write");
  const before = {
    board: text(root, "board/BOARD.md"),
    tasks: text(root, "board/TASKS.md"),
    file: text(root, "board/sprints/A1_one.md"),
  };
  const result = addTask(root, {
    id: "W4",
    sprint: "A1",
    note: "Fourth",
    deps: ["W2"],
    risky: true,
  });
  assert.equal(result.exit, 0, result.out);
  const w2 = "| W2   | A1     | doing  | W1   | *    | The second   |   \n";
  assert.equal(
    text(root, "board/BOARD.md"),
    before.board.replace(w2, `${w2}| W4 | A1 | todo | W2 | * | Fourth |\n`),
  );
  assert.equal(
    text(root, "board/sprints/A1_one.md"),
    before.file.replace("| The second | W1   |\n", "| The second | W1   |\n| W4 | Fourth | W2 |\n"),
  );
  assert.equal(
    text(root, "board/TASKS.md"),
    before.tasks.replace("owns two.\n", "owns two.\n- **W4** (A1): Fourth, added 2026-05-01\n"),
  );
});

test("add on a new sprint falls back to the end of the table and the right block heading", () => {
  const root = copy("write");
  const result = addTask(root, { id: "W5", sprint: "A2", note: "Fifth" });
  assert.equal(result.exit, 0, result.out);
  assert.match(
    text(root, "board/BOARD.md"),
    /\| W3 {3}\| A2 {5}\| todo {3}\| W2 {3}\| {6}\| Pipe \\\| here \|\n\| W5 \| A2 \| todo \| {2}\| {2}\| Fifth \|\n/,
  );
  assert.match(
    text(root, "board/TASKS.md"),
    /\*\*W3\*\* \(A2\): owns three\.\n\n- \*\*W5\*\* \(A2\): Fifth, added 2026-05-01\n/,
  );
});

test("add refuses a duplicate id and writes nothing", () => {
  const root = copy("write");
  const before = text(root, "board/BOARD.md");
  const result = addTask(root, { id: "W2", sprint: "A1", note: "again" });
  assert.equal(result.exit, 2);
  assert.match(result.out, /task "W2" is already on the board/);
  assert.equal(text(root, "board/BOARD.md"), before);
});

test("add refuses when any location cannot be written, leaving every file as it was", () => {
  const root = copy("write");
  const files = ["board/BOARD.md", "board/sprints/A1_one.md", "board/TASKS.md"];
  const before = files.map((f) => text(root, f));
  writeFileSync(
    join(root, "board/TASKS.md"),
    text(root, "board/TASKS.md").replace("## Sprint A1", "## Sprint One"),
  );
  const changed = text(root, "board/TASKS.md");
  const result = addTask(root, { id: "W4", sprint: "A1", note: "Fourth" });
  assert.equal(result.exit, 2);
  assert.match(result.out, /no heading "Sprint A1"/);
  assert.deepEqual(
    files.slice(0, 2).map((f) => text(root, f)),
    before.slice(0, 2),
  );
  assert.equal(text(root, "board/TASKS.md"), changed);
});

test("add refuses bad input: no id, bad JSON, unknown kind or parent, unknown placeholder", () => {
  const root = copy("write");
  assert.match(addTask(root, { sprint: "A1" }).out, /needs an "id"/);
  assert.match(call(add, root, ["task", "--fields", "{nope"]).out, /not valid JSON/);
  assert.match(call(add, root, ["task"]).out, /→ board add --help/);
  assert.match(addTask(root, { id: "W4" }, "story").out, /unknown kind "story"/);
  assert.match(addTask(root, { id: "W4", sprint: "Z9" }).out, /sprint "Z9" is not on the board/);
  assert.match(addTask(root, { id: "S1" }, "sprint").out, /no "create"/);
  const { spec } = loadSpec(join(root, "process.json"));
  spec.kinds.task.create.rows[0].cells.Note = "{whatever}";
  const model = readProcess({ root, spec });
  assert.match(
    add(["task", "--fields", '{"id":"W4","sprint":"A1"}'], { root, spec, model }).out,
    /unknown placeholder \{whatever\}/,
  );
});

test("add refuses a create target that is missing or a dangling symlink, naming it, and writes nothing", () => {
  for (const make of [
    (file) => rmSync(file),
    (file) => {
      rmSync(file);
      symlinkSync("gone.md", file);
    },
  ]) {
    const root = copy("write");
    const before = text(root, "board/BOARD.md");
    make(join(root, "board/TASKS.md"));
    let result;
    assert.doesNotThrow(() => {
      result = addTask(root, { id: "W4", sprint: "A1", note: "Fourth" });
    });
    assert.equal(result.exit, 2);
    assert.match(
      result.out,
      /^✗ board add: cannot read .*board\/TASKS\.md \(ENOENT\); nothing written$/,
    );
    assert.equal(text(root, "board/BOARD.md"), before);
  }
});

test("add reads a field named like a built-in from the given JSON only", () => {
  const root = copy("write");
  const { spec: loaded } = loadSpec(join(root, "process.json"));
  // The task's parent field renamed `toString`, and left out of the JSON.
  const renamed = JSON.stringify(loaded)
    .replaceAll('"sprint":{"column"', '"toString":{"column"')
    .replaceAll("{sprint}", "{toString}")
    .replaceAll("after-last:sprint", "after-last:toString");
  const spec = JSON.parse(renamed);
  const model = readProcess({ root, spec });
  const result = add(["task", "--fields", '{"id":"W4","note":"x"}'], { root, spec, model });
  assert.equal(result.exit, 2);
  assert.match(result.out, /^✗ board add: toString "" is not on the board$/);
});

test("add on table-board, then check: findings are unchanged", () => {
  const root = copy("table-board");
  const baseline = findings(root);
  const result = addTask(root, {
    id: "W6",
    sprint: "B1",
    what: "A new door",
    deps: ["W5"],
    risky: false,
    under: "1. Contracts",
  });
  assert.equal(result.exit, 0, result.out);
  assert.ok(
    text(root, "docs/board/BOARD.md").includes(
      "| W5 | B1 | todo | W4 |  |  |  | The door \\| the hinge |\n| W6 | B1 | todo | W5 |  |  |  | A new door |\n",
    ),
  );
  assert.match(text(root, "docs/board/sprints/B1_the_door.md"), /\| W6 \| A new door \| W5 \|/);
  assert.ok(
    text(root, "docs/board/TASKS.md").endsWith(
      "**W5 · The door** (B1): owns `src/door.mjs` · accept: the door opens.\n\n- **W6** (B1): owns …\n",
    ),
  );
  assert.deepEqual(findings(root), baseline);
  const q = call(add, root, [
    "question",
    "--fields",
    JSON.stringify({ id: "Q-03", question: "Open the door?", blocks: ["W6"] }),
    "--apply",
  ]);
  assert.equal(q.exit, 0, q.out);
  assert.match(
    text(root, "docs/board/BOARD.md"),
    /\| Q-03 \| Open the door\? \| open \| W6 \| {2}\|\n/,
  );
  assert.deepEqual(findings(root), baseline);
});

test("add on a board made from the templates: headings given with their # marks", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-cli-"));
  temps.push(root);
  cpSync(TEMPLATES, join(root, "docs", "work"), { recursive: true });
  cpSync(join(TEMPLATES, "process.json"), join(root, "process.json"));
  const task = addTask(root, { id: "T2", sprint: "S1", what: "The second task", deps: "T1" });
  assert.equal(task.exit, 0, task.out);
  const sprint = addTask(root, { id: "S2", name: "Second sprint" }, "sprint");
  assert.equal(sprint.exit, 0, sprint.out);
  const tasks = text(root, "docs/work/TASKS.md");
  assert.match(tasks, /call it done\n\n### T2 · The second task\n- \*\*Owns:\*\* …\n/);
  assert.match(tasks, /\n\n## S2 · Second sprint\n$/);
  assert.match(text(root, "docs/work/BOARD.md"), /\| S2 \| Second sprint \| todo \| {2}\|\n/);
  assert.deepEqual(findings(root), []);
});

test("add takes an `also` literal as the parent: its own row is written, the parent's places skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-cli-"));
  temps.push(root);
  cpSync(TEMPLATES, join(root, "docs", "work"), { recursive: true });
  const spec = JSON.parse(readFileSync(join(TEMPLATES, "process.json"), "utf8"));
  spec.kinds.task.fields.sprint.also = ["LATER"];
  writeFileSync(join(root, "process.json"), JSON.stringify(spec));
  const tasks = text(root, "docs/work/TASKS.md");
  const result = addTask(root, { id: "T9", sprint: "LATER", what: "Someday", deps: "" });
  assert.equal(result.exit, 0, result.out);
  assert.match(text(root, "docs/work/BOARD.md"), /\| T9 \| LATER \| Someday \| todo \|/);
  assert.equal(text(root, "docs/work/TASKS.md"), tasks, "no sprint heading to write under");
  assert.match(result.out, /skipped the block under "## \{sprint\} · \{parent\.name\}": LATER/);
  assert.deepEqual(findings(root), []);
});

test("add with an `also` parent skips the parent-file row and writes a block that needs no parent", () => {
  const root = copy("write");
  const spec = JSON.parse(text(root, "process.json"));
  spec.kinds.task.fields.sprint.also = ["LATER"];
  writeFileSync(join(root, "process.json"), JSON.stringify(spec));
  writeFileSync(join(root, "board/TASKS.md"), `${text(root, "board/TASKS.md")}\n## Sprint LATER\n`);
  const result = addTask(root, { id: "W8", sprint: "LATER", note: "Parked" });
  assert.equal(result.exit, 0, result.out);
  assert.match(result.out, /skipped the row in LATER's file: LATER is not an item/);
  assert.match(text(root, "board/TASKS.md"), /## Sprint LATER\n\n- \*\*W8\*\* \(LATER\): Parked/);
});

test("add skips the parent-file row for a sprint that has no file, and says so", () => {
  const root = copy("write");
  writeFileSync(
    join(root, "board/BOARD.md"),
    text(root, "board/BOARD.md").replace(
      "| A2     | todo   |",
      "| A2     | todo   |\n| A3     | todo   |",
    ),
  );
  writeFileSync(join(root, "board/TASKS.md"), `${text(root, "board/TASKS.md")}## Sprint A3\n`);
  const result = addTask(root, { id: "W7", sprint: "A3", note: "Seventh" });
  assert.equal(result.exit, 0, result.out);
  assert.match(result.out, /skipped the row in sprint A3's file/);
  assert.match(text(root, "board/BOARD.md"), /\| W7 \| A3 \| todo/);
});

test("set changes one status cell and nothing else", () => {
  const root = copy("write");
  const before = text(root, "board/BOARD.md");
  const result = call(set, root, ["task", "W3", "status=doing", "--apply"]);
  assert.equal(result.exit, 0, result.out);
  assert.equal(
    text(root, "board/BOARD.md"),
    before.replace("| W3   | A2     | todo   |", "| W3   | A2     | doing  |"),
  );
});

test("set refuses an unknown status, field, item and an id column", () => {
  const root = copy("write");
  const before = text(root, "board/BOARD.md");
  assert.match(call(set, root, ["task", "W3", "status=finished"]).out, /not a task status/);
  assert.match(call(set, root, ["task", "W3", "owner=me"]).out, /no field "owner"/);
  assert.match(call(set, root, ["task", "W9", "status=done"]).out, /no task "W9"/);
  assert.match(call(set, root, ["task", "W3"]).out, /→ board set --help/);
  assert.equal(call(set, root, ["task", "W3", "status=nope"]).exit, 2);
  assert.equal(text(root, "board/BOARD.md"), before);
  const tb = copy("table-board");
  assert.match(call(set, tb, ["milestone", "M1", "name=Other"]).out, /shares the id column/);
});

test("set writes a frontmatter key for a one-file-per-item kind", () => {
  const root = copy("frontmatter-board");
  const before = text(root, "plan/stories/S-2.md");
  const result = call(set, root, ["story", "S-2", "status=done", "--apply"]);
  assert.equal(result.exit, 0, result.out);
  const after = text(root, "plan/stories/S-2.md");
  assert.equal(after.split("\n").length, before.split("\n").length);
  assert.match(after, /^status: done$/m);
});

// A scratch copy of the write board whose task kind takes its ids from `pattern`.
function patterned(pattern) {
  const root = copy("write");
  const file = join(root, "process.json");
  const spec = JSON.parse(readFileSync(file, "utf8"));
  spec.kinds.task.create.id = pattern;
  writeFileSync(file, JSON.stringify(spec));
  return root;
}

test("add fills the id from the create.id pattern when --json gives none, and prints it", () => {
  const root = patterned("W{n}");
  const result = addTask(root, { sprint: "A1", note: "Fourth" });
  assert.equal(result.exit, 0, result.out);
  assert.match(result.out, /^added task W4\b/);
  assert.match(text(root, "board/BOARD.md"), /\| W4 +\| A1 +\| todo +\| +\| +\| Fourth +\|\n/);
});

test("add keeps an id the caller gives even when create.id is a pattern", () => {
  const root = patterned("W{n}");
  const result = addTask(root, { id: "W9", sprint: "A1", note: "Ninth" });
  assert.equal(result.exit, 0, result.out);
  assert.match(result.out, /^added task W9\b/);
});

test("add still requires an id when create.id is ask", () => {
  const root = patterned("ask");
  const result = addTask(root, { sprint: "A1", note: "No id" });
  assert.equal(result.exit, 2);
  assert.match(result.out, /needs an "id"/);
});

// The write board with a contract declared for tasks (and, optionally, no block written on create).
function contracted({ blocks = true } = {}) {
  const root = copy("write");
  const file = join(root, "process.json");
  const spec = JSON.parse(readFileSync(file, "utf8"));
  spec.kinds.task.contract = { blocks: ["TASKS.md"], lead: ["bold"] };
  if (!blocks) spec.kinds.task.create.blocks = undefined;
  writeFileSync(file, JSON.stringify(spec));
  return root;
}

test("add warns that a new task has no contract exec can find, and says how to add one", () => {
  const root = contracted({ blocks: false });
  const result = addTask(root, { id: "W4", sprint: "A1", note: "Fourth" });
  assert.equal(result.exit, 0, result.out);
  assert.match(result.out, /no contract for W4/);
  assert.match(result.out, /\*\*W4\*\*.*TASKS\.md/);
  assert.match(result.out, /board contract W4/);
});

test("add says nothing about contracts when the block it writes is one the lookup finds", () => {
  const root = contracted();
  const result = addTask(root, { id: "W4", sprint: "A1", note: "Fourth" });
  assert.equal(result.exit, 0, result.out);
  assert.doesNotMatch(result.out, /contract/);
});

test("add refuses a pattern that needs more than a number, writing nothing", () => {
  const root = patterned("W-{parent}-{n}");
  const before = text(root, "board/BOARD.md");
  const result = addTask(root, { sprint: "A1", note: "Odd" });
  assert.equal(result.exit, 2);
  assert.match(result.out, /needs more than a number/);
  assert.equal(text(root, "board/BOARD.md"), before);
});
