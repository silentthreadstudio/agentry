// Tests for lib/process/board-diff.mjs: two versions of a synthetic board, each read with the real reader,
// and what `diffBoard` says changed. A lifecycle write comes out as cells; any other byte (prose, another
// column, a handoff line, a row added, a frontmatter key no field reads) comes out as `other`, and
// `strayChanges` names everything that is not a lifecycle cell of an open lane.
// Run: node --test plugin/scripts/test/board-diff.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  boardFiles,
  cellEdits,
  cellText,
  diffBoard,
  strayChanges,
} from "../lib/process/board-diff.mjs";
import { readProcess } from "../lib/process/read.mjs";

const SPEC = {
  version: 1,
  name: "Diff",
  root: "plan",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
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
      },
    },
    note: {
      label: "Note",
      at: { files: "notes/*.md", id: "frontmatter:id" },
      fields: { status: { column: "status" } },
    },
  },
  rules: [],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", merged: "done" },
    write: {
      status: "status",
      verdict: "verdict",
      commit: "commit",
      handoff: "parent.file:handoff",
    },
    handoff: "- **{id}** ({sha}): {summary}",
  },
};
const BOARD = `# Diff

## Sprints

| Sprint | Status |
| ------ | ------ |
| S1     | doing  |

## Tasks

Prose about the tasks.

| Task | Sprint | Status | Verdict | Commit | Title |
| ---- | ------ | ------ | ------- | ------ | ----- |
| T1   | S1     | todo   |         |        | one   |
| T2   | S1     | todo   |         |        | two   |
`;
const SPRINT = "# S1\n\n## Handoff\n\n## Notes\n";
const NOTE = "---\nid: N1\nstatus: open\nowner: ada\n---\n\nBody.\n";
const FILES = { "plan/BOARD.md": BOARD, "plan/sprints/S1.md": SPRINT, "plan/notes/n1.md": NOTE };

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One version of the board: the files written to a scratch root and read by the reader. */
function version(edits = {}) {
  const root = mkdtempSync(join(tmpdir(), "board-diff-"));
  dirs.push(root);
  for (const [file, text] of Object.entries({ ...FILES, ...edits })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const text = (file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return null;
    }
  };
  return { model: readProcess({ root, spec: SPEC }), text };
}
const diffOf = (edits, files) =>
  diffBoard({ spec: SPEC, before: version(), after: version(edits), files });
const boardWith = (...pairs) => pairs.reduce((text, [from, to]) => text.replace(from, to), BOARD);
const T2_TODO = "| T2   | S1     | todo   |         |";

test("boardFiles lists every file the reader read, relative to the git root", () => {
  assert.deepEqual(boardFiles(SPEC, version().model), [
    "plan/BOARD.md",
    "plan/notes/n1.md",
    "plan/sprints/S1.md",
  ]);
});

test("identical versions differ in nothing", () => {
  assert.deepEqual(diffOf({}), { cells: [], other: [] });
});

test("a lifecycle write comes out as cells, a grown cell included, and is no stray change", () => {
  const diff = diffOf({
    "plan/BOARD.md": boardWith([T2_TODO, "| T2   | S1     | verify | PASS WITH NOTES |"]),
  });
  assert.deepEqual(diff.other, []);
  assert.deepEqual(
    diff.cells.map(({ id, field, from, to, file, line }) => ({ id, field, from, to, file, line })),
    [
      { id: "T2", field: "status", from: "todo", to: "verify", file: "plan/BOARD.md", line: 16 },
      {
        id: "T2",
        field: "verdict",
        from: "",
        to: "PASS WITH NOTES",
        file: "plan/BOARD.md",
        line: 16,
      },
    ],
  );
  assert.deepEqual(strayChanges(SPEC, diff, { ids: ["T2"] }), []);
});

test("prose added or edited anywhere is other, with its line", () => {
  const added = diffOf({ "plan/BOARD.md": boardWith(["## Tasks\n", "## Tasks\n\nHAND NOTE\n"]) });
  assert.deepEqual(added.other, [
    { file: "plan/BOARD.md", line: 11, what: 'lines added or removed, from "HAND NOTE"' },
  ]);
  const edited = diffOf({ "plan/BOARD.md": boardWith(["Prose about", "Words about"]) });
  assert.deepEqual(edited.other, [
    { file: "plan/BOARD.md", line: 11, what: 'changed: "Words about the tasks."' },
  ]);
});

test("a cell no field reads, or one that changed but reads the same, is other", () => {
  const title = diffOf({ "plan/BOARD.md": boardWith(["| one   |", "| uno   |"]) });
  assert.deepEqual(title.cells, []);
  assert.match(title.other[0].what, /T1: the "Title" cell changed, and no field reads it/);
  const bold = diffOf({
    "plan/BOARD.md": boardWith(["| T1   | S1     | todo   |", "| T1   | S1     | **todo** |"]),
  });
  assert.deepEqual(bold.cells, []);
  assert.match(bold.other[0].what, /T1: the "Status" cell's text changed, but it reads the same/);
  const padded = diffOf({
    "plan/BOARD.md": boardWith(["| T1   | S1     | todo   |", "| T1   | S1     | todo |"]),
  });
  assert.match(padded.other[0].what, /reads the same/);
});

test("a lifecycle cell next to a hand edit on the same row still names the hand edit", () => {
  const diff = diffOf({
    "plan/BOARD.md": boardWith([
      "| T2   | S1     | todo   |         |        | two   |",
      "| T2   | S1     | doing  |         |        | 2     |",
    ]),
  });
  assert.equal(diff.cells.length, 1);
  assert.deepEqual(strayChanges(SPEC, diff, { ids: ["T2"] }), [
    'plan/BOARD.md:16: T2: the "Title" cell changed, and no field reads it',
  ]);
});

test("a non-lifecycle field, another kind's cell, or a cell of an item with no open lane is stray", () => {
  const diff = diffOf({
    "plan/BOARD.md": boardWith(
      ["| S1     | doing  |", "| S1     | done   |"],
      ["| T2   | S1     | todo   |", "| T2   | S0     | doing  |"],
      ["| T1   | S1     | todo   |", "| T1   | S1     | doing  |"],
    ),
  });
  assert.deepEqual(diff.other, []);
  const stray = strayChanges(SPEC, diff, { ids: ["T2"] }).join("\n");
  assert.match(stray, /sprint S1 status "doing" → "done" is not a lifecycle cell/);
  assert.match(stray, /task T2 sprint "S1" → "S0" is not a lifecycle cell/);
  assert.match(stray, /task T1 status "todo" → "doing", but T1 has no open lane/);
  assert.doesNotMatch(stray, /T2 status/);
});

test("a row added or removed is other", () => {
  const added = diffOf({
    "plan/BOARD.md": `${BOARD}| T3   | S1     | todo   |         |        | three |\n`,
  });
  assert.match(added.other[0].what, /lines added or removed, from "\| T3/);
  const removed = diffOf({
    "plan/BOARD.md": boardWith(["| T2   | S1     | todo   |         |        | two   |\n", ""]),
  });
  assert.match(removed.other[0].what, /lines added or removed/);
});

test("a row swapped for another item on the same line is other", () => {
  const diff = diffOf({ "plan/BOARD.md": boardWith(["| T2   | S1", "| T9   | S1"]) });
  assert.deepEqual(diff.cells, []);
  assert.match(diff.other[0].what, /changed: "\| T9/);
});

test("a handoff line in an item's own file is other, never a cell", () => {
  const diff = diffOf({
    "plan/sprints/S1.md": "# S1\n\n## Handoff\n- **T1** (abc1234): x\n## Notes\n",
  });
  assert.deepEqual(diff.cells, []);
  assert.deepEqual(diff.other, [
    { file: "plan/sprints/S1.md", line: 4, what: 'changed: "- **T1** (abc1234): x"' },
  ]);
});

test("a frontmatter field is a cell; a key no field reads is other", () => {
  const field = diffOf({ "plan/notes/n1.md": NOTE.replace("status: open", "status: closed") });
  assert.deepEqual(field.other, []);
  assert.deepEqual(
    field.cells.map(({ kind, id, field: f, to }) => ({ kind, id, f, to })),
    [{ kind: "note", id: "N1", f: "status", to: "closed" }],
  );
  const owner = diffOf({ "plan/notes/n1.md": NOTE.replace("owner: ada", "owner: bob") });
  assert.match(owner.other[0].what, /N1: the "owner" cell changed, and no field reads it/);
  const body = diffOf({ "plan/notes/n1.md": NOTE.replace("Body.", "Edited.") });
  assert.match(body.other[0].what, /changed: "Edited\."/);
});

// A one-file item's cell named the item's line, not the line of its key.
test("a frontmatter cell is located at its key's line", () => {
  const diff = diffOf({ "plan/notes/n1.md": NOTE.replace("status: open", "status: closed") });
  assert.equal(diff.cells[0].line, 3);
  assert.deepEqual(strayChanges(SPEC, diff, { ids: [] }), [
    'plan/notes/n1.md:3: note N1 status "open" → "closed" is not a lifecycle cell',
  ]);
});

test("a changed path that is not a board file is other; so is a board file one version lacks", () => {
  assert.deepEqual(diffOf({}, ["src/app.js", "plan/BOARD.md"]).other, [
    { file: "src/app.js", what: "not a board file" },
  ]);
  const gone = diffOf({ "plan/notes/n1.md": null });
  assert.ok(
    gone.other.some((o) => o.file === "plan/notes/n1.md" && o.what === "a board file removed"),
  );
});

// The carry went back as a text patch, which a neighbour row's change broke; it goes
// back cell by cell now, each found by its id.
const T2_STATUS = {
  kind: "task",
  id: "T2",
  field: "status",
  column: "Status",
  file: "plan/BOARD.md",
  from: "todo",
  to: "doing",
};
const put = (board) => {
  const plan = cellEdits(SPEC, board, [T2_STATUS]);
  const text = plan.edits.reduce((t, e) => e.edit(t), board.text("plan/BOARD.md"));
  return { plan, text };
};

test("cellText reads a cell by its item's id, wherever the row is now", () => {
  const moved = version({
    "plan/BOARD.md": boardWith(["Prose about the tasks.\n", "Prose.\n\nMore prose.\n"]),
  });
  assert.equal(cellText(SPEC, moved, { kind: "task", id: "T2", column: "Status" }), "todo");
  assert.equal(cellText(SPEC, moved, { kind: "task", id: "T9", column: "Status" }), null);
  assert.equal(cellText(SPEC, moved, { kind: "note", id: "N1", column: "status" }), "open");
});

test("cellEdits sets a carried cell that reads its from, next to a row that changed meanwhile", () => {
  const board = version({
    "plan/BOARD.md": boardWith(["| T1   | S1     | todo   |", "| T1   | S1     | doing  |"]),
  });
  const { plan, text } = put(board);
  assert.deepEqual([plan.set.length, plan.there.length, plan.conflicts.length], [1, 0, 0]);
  assert.equal(
    text,
    boardWith(
      ["| T1   | S1     | todo   |", "| T1   | S1     | doing  |"],
      [T2_TODO, "| T2   | S1     | doing  |         |"],
    ),
  );
});

test("cellEdits leaves a cell already at its to, and names one that reads anything else", () => {
  const there = put(
    version({ "plan/BOARD.md": boardWith([T2_TODO, "| T2   | S1     | doing  |"]) }),
  );
  assert.deepEqual([there.plan.there.length, there.plan.edits.length], [1, 0]);
  const changed = put(
    version({ "plan/BOARD.md": boardWith([T2_TODO, "| T2   | S1     | verify |"]) }),
  );
  assert.deepEqual(changed.plan.edits, []);
  assert.deepEqual(changed.plan.conflicts, [{ ...T2_STATUS, now: "verify" }]);
});
