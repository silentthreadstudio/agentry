// Tests for lib/process/write.mjs — the pure text edits and the re-read guard.
// Golden style: each edit is compared with the original text changed by hand in exactly one place,
// so "every other byte is kept" is the assertion. Fixture: test/fixtures/write (invented content).
// Run: node --test plugin/scripts/test/write.test.mjs
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WriteError,
  appendBlock,
  appendLine,
  apply,
  insertRow,
  setCell,
  setKey,
} from "../lib/process/write.mjs";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "fixtures/write/board");
const read = (rel) => readFileSync(join(BOARD, rel), "utf8");
const board = read("BOARD.md");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const tasks = { heading: "Tasks", idColumn: "Task" };
const refused = (fn, pattern) =>
  assert.throws(fn, (e) => e instanceof WriteError && pattern.test(e.message));

test("setCell changes one cell and keeps every other byte, padding and trailing spaces included", () => {
  const out = setCell(board, { ...tasks, id: "W1", column: "Status", value: "doing" });
  assert.equal(out, board.replace("| W1   | A1     | done   |", "| W1   | A1     | doing  |"));
});

test("setCell leaves a row's trailing spaces and the same id in another table alone", () => {
  const out = setCell(board, { ...tasks, id: "W2", column: "Status", value: "done" });
  assert.equal(
    out,
    board.replace("| W2   | A1     | doing  | W1", "| W2   | A1     | done   | W1"),
  );
  assert.ok(out.includes("The second   |   \n"), "trailing spaces survive");
  assert.ok(out.includes("| W2   | A1     | todo   |"), "the Archive row is untouched");
});

test("setCell grows a cell that does not fit, without touching its neighbours", () => {
  const out = setCell(board, { ...tasks, id: "W3", column: "Status", value: "in review" });
  assert.equal(out, board.replace("| W3   | A2     | todo   |", "| W3   | A2     | in review |"));
});

test("setCell escapes a pipe and clears a cell to blank", () => {
  assert.ok(
    setCell(board, { ...tasks, id: "W1", column: "Note", value: "a|b" }).includes("| a\\|b "),
  );
  const out = setCell(board, { ...tasks, id: "W2", column: "Deps", value: "" });
  assert.equal(out, board.replace("| doing  | W1   | *", "| doing  |      | *"));
});

test("setCell reads the id through idMatch and bold markers", () => {
  const text = "## T\n\n| Task | S |\n| --- | --- |\n| **W3 · x** | a |\n";
  const out = setCell(text, {
    heading: "T",
    idColumn: "Task",
    idMatch: "^(\\S+)",
    id: "W3",
    column: "S",
    value: "b",
  });
  assert.equal(out, text.replace("| a |", "| b |"));
});

test("setCell refuses a missing row, a missing column, an ambiguous id and a line break", () => {
  refused(
    () => setCell(board, { ...tasks, id: "W9", column: "Status", value: "x" }),
    /no row "W9"/,
  );
  refused(
    () => setCell(board, { ...tasks, id: "W1", column: "Owner", value: "x" }),
    /no column "Owner"/,
  );
  refused(
    () => setCell(board, { ...tasks, id: "W1", column: "Status", value: "a\nb" }),
    /line break/,
  );
  const twice = board.replace("| W3   | A2", "| W1   | A2");
  refused(() => setCell(twice, { ...tasks, id: "W1", column: "Status", value: "x" }), /2 rows/);
  refused(
    () =>
      setCell(board, { heading: "Nope", idColumn: "Task", id: "W1", column: "Status", value: "x" }),
    /no heading/,
  );
});

test("setCell keeps CRLF line endings", () => {
  const crlf = board.replaceAll("\n", "\r\n");
  const out = setCell(crlf, { ...tasks, id: "W1", column: "Status", value: "doing" });
  assert.equal(out, crlf.replace("| done   |", "| doing  |"));
});

test("insertRow after-last puts the row after the last row with the same sprint", () => {
  const cells = { Task: "W4", Sprint: "A1", Status: "todo", Note: "New" };
  const out = insertRow(board, { heading: "Tasks", cells, at: "after-last:Sprint" });
  const w2 = "| W2   | A1     | doing  | W1   | *    | The second   |   \n";
  assert.equal(out, board.replace(w2, `${w2}| W4 | A1 | todo |  |  | New |\n`));
});

test("insertRow after-last falls back to the end when no row shares the value", () => {
  const cells = { Task: "W4", Sprint: "B1", Status: "todo" };
  const out = insertRow(board, { heading: "Tasks", cells, at: "after-last:Sprint" });
  assert.equal(out, board.replace("here |\n", "here |\n| W4 | B1 | todo |  |  |  |\n"));
});

test("insertRow end appends after the last row, before the next section", () => {
  const out = insertRow(board, {
    heading: "Sprints",
    cells: { Sprint: "A3", Status: "todo" },
    at: "end",
  });
  assert.equal(out, board.replace("| A2     | todo   |\n", "| A2     | todo   |\n| A3 | todo |\n"));
});

test("insertRow leaves a header named like a built-in empty when the new row has no cell for it", () => {
  const table =
    "## Log\n\n| Id | valueOf | constructor | toString | __proto__ |\n| --- | --- | --- | --- | --- |\n";
  const out = insertRow(table, { heading: "Log", cells: { Id: "L1" }, at: "end" });
  assert.equal(out, `${table}| L1 |  |  |  |  |\n`);
});

test("insertRow refuses a column the table lacks, an unknown position and a missing table", () => {
  refused(
    () => insertRow(board, { heading: "Sprints", cells: { Owner: "x" }, at: "end" }),
    /no column "Owner"/,
  );
  refused(
    () => insertRow(board, { heading: "Sprints", cells: { Sprint: "A3" }, at: "middle" }),
    /unknown position/,
  );
  refused(
    () =>
      insertRow(board, { heading: "Sprints", cells: { Sprint: "A3" }, at: "after-last:Status" }),
    /needs the column/,
  );
  refused(() => insertRow("# x\n", { heading: "x", cells: {}, at: "end" }), /no table/);
});

test("appendBlock continues a list without a blank line", () => {
  const tasksFile = read("TASKS.md");
  const out = appendBlock(tasksFile, { under: "Sprint A1", block: "- **W4** (A1): owns four." });
  assert.equal(out, tasksFile.replace("owns two.\n", "owns two.\n- **W4** (A1): owns four.\n"));
});

test("appendBlock after a paragraph leaves a blank line, and keeps the section's trailing blank", () => {
  const tasksFile = read("TASKS.md");
  const out = appendBlock(tasksFile, { under: "Sprint A2", block: "- **W5** (A2): owns five." });
  assert.equal(
    out,
    tasksFile.replace("owns three.\n", "owns three.\n\n- **W5** (A2): owns five.\n"),
  );
});

test("appendBlock into an empty section goes under the heading", () => {
  const tasksFile = read("TASKS.md");
  const out = appendBlock(tasksFile, { under: "Sprint B9", block: "- **W6** (B9): owns six.\n" });
  assert.equal(
    out,
    tasksFile.replace("## Sprint B9\n", "## Sprint B9\n\n- **W6** (B9): owns six.\n"),
  );
});

test("appendBlock refuses a heading that is not there", () => {
  refused(
    () => appendBlock(read("TASKS.md"), { under: "Sprint Z", block: "x" }),
    /no heading "Sprint Z"/,
  );
});

test("appendLine adds the line directly after the section's last line, even at end of file", () => {
  const sprint = read("sprints/A1_one.md");
  const out = appendLine(sprint, { heading: "Handoff", line: "- **W2** (b2c3d4e): done." });
  assert.equal(out, `${sprint}- **W2** (b2c3d4e): done.\n`);
  const bare = sprint.trimEnd();
  assert.equal(appendLine(bare, { heading: "Handoff", line: "- z" }), `${bare}\n- z`);
});

test("setKey changes one frontmatter value and nothing else", () => {
  const text = "---\nepic: E1\nstatus: open\nshipped: 2026-03-01\n---\n\n# Body\n";
  assert.equal(setKey(text, { key: "status", value: "closed" }), text.replace("open", "closed"));
  refused(() => setKey(text, { key: "owner", value: "x" }), /no frontmatter key "owner"/);
  refused(() => setKey("# no frontmatter\n", { key: "status", value: "x" }), /no frontmatter key/);
});

function scratch(text) {
  const dir = mkdtempSync(join(tmpdir(), "agentry-write-"));
  temps.push(dir);
  const file = join(dir, "BOARD.md");
  writeFileSync(file, text);
  return file;
}

test("apply writes the edit", () => {
  const file = scratch(board);
  apply(file, (text) => setCell(text, { ...tasks, id: "W1", column: "Status", value: "doing" }));
  assert.match(readFileSync(file, "utf8"), /\| W1 {3}\| A1 {5}\| doing {2}\|/);
});

test("apply refuses, and writes nothing, when the file changed between the read and the write", () => {
  const file = scratch(board);
  const handEdit = `${board}\nA line the owner typed meanwhile.\n`;
  assert.throws(
    () =>
      apply(file, (text) => {
        writeFileSync(file, handEdit); // the owner saves between our read and our write
        return setCell(text, { ...tasks, id: "W1", column: "Status", value: "doing" });
      }),
    (e) => e instanceof WriteError && /changed/.test(e.message),
  );
  assert.equal(readFileSync(file, "utf8"), handEdit, "the owner's text is what is on disk");
});

test("apply replaces the file whole: a reader that opened it before keeps the old text", () => {
  const file = scratch("old text\n");
  const fd = openSync(file, "r");
  apply(file, () => "new text, longer than the old\n");
  const buf = Buffer.alloc(64);
  assert.equal(buf.subarray(0, readSync(fd, buf, 0, 64, 0)).toString(), "old text\n");
  assert.equal(readFileSync(file, "utf8"), "new text, longer than the old\n");
});

test("apply keeps the file's mode and writes through a symlink", () => {
  const file = scratch("a\n");
  chmodSync(file, 0o600);
  const link = join(dirname(file), "LINK.md");
  symlinkSync(file, link);
  apply(link, () => "b\n");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(file, "utf8"), "b\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("apply writes nothing when the edit itself refuses", () => {
  const file = scratch(board);
  refused(
    () =>
      apply(file, (text) => setCell(text, { ...tasks, id: "W9", column: "Status", value: "x" })),
    /no row/,
  );
  assert.equal(readFileSync(file, "utf8"), board);
});
