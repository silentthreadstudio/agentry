// Tests for the debt kind (A43): a kind exec runs beside the lifecycle (`exec.kinds`), read and written
// without a terminal or a git repository. The workflow key's cross-file refusals (`ACROSS_CASES`, through
// `validateSpec` and `board check`), the accessors and `runId`, `applyEvent`'s kind, `strayChanges` per
// kind, the status view's `side` and its row, and the format reference's "exec kinds" table. The lanes
// themselves run in `debt-lane.test.mjs`. Fixture: `fixtures/debt-board`.
// Run: node --test plugin/scripts/test/debt-kind.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { strayChanges } from "../lib/process/board-diff.mjs";
import { runId } from "../lib/process/ids.mjs";
import { applyEvent } from "../lib/process/lifecycle.mjs";
import * as md from "../lib/process/markdown.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import { renderStatus } from "../lib/process/render.mjs";
import { validateSpec } from "../lib/process/spec.mjs";
import {
  execKindSchema,
  flaggedItem,
  lifecycleOf,
  runKinds,
} from "../lib/process/spec/workflow.mjs";
import { boardReport, statusView, workKind } from "../lib/process/status.mjs";
import { WriteError } from "../lib/process/write.mjs";
import { ACROSS_CASES, pathOf, specOf } from "./key-cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "debt-board");
const BOARD = join(HERE, "..", "board.mjs");
const PLUGIN = join(HERE, "..", "..");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-debt-"));
  temps.push(dir);
  return dir;
};

// A copy of the fixture outside any repository, with `edit(text)` applied to its BOARD.md.
function copy(edit = (text) => text) {
  const root = temp();
  cpSync(FIXTURE, root, { recursive: true });
  const file = join(root, "BOARD.md");
  writeFileSync(file, edit(readFileSync(file, "utf8")));
  return root;
}
const load = (root, change = (spec) => spec) => {
  const { spec, problems } = loadSpec(join(root, "process.json"));
  assert.deepEqual(problems, []);
  const changed = change(structuredClone(spec));
  return { root, spec: changed, model: readProcess({ root, spec: changed }) };
};
const boardText = (root) => readFileSync(join(root, "BOARD.md"), "utf8");
const changedLines = (before, after) => {
  const a = before.split("\n");
  return after.split("\n").filter((line, i) => line !== a[i]);
};
// The fixture's spec without the debt kind, its table or `exec.kinds`.
const withoutDebt = ({ kinds: { debt: _debt, ...kinds }, exec: _exec, ...spec }) => ({
  ...spec,
  kinds,
});

// ---- the workflow key -----------------------------------------------------------------------------

test("each cross-file exec.kinds refusal names its paths and the file that holds them", () => {
  const files = { board: "process.json", workflow: "workflow.json" };
  for (const c of ACROSS_CASES) {
    const { problems } = validateSpec(specOf(c), { files });
    assert.deepEqual([...new Set(problems.map((p) => pathOf(p.message)))].sort(), c.bad, c.name);
    for (const p of problems) assert.equal(p.file, c.file, `${c.name}: ${p.message}`);
  }
});

test("board check exits 2 on each cross-file exec.kinds refusal, under the file that holds it", () => {
  for (const c of ACROSS_CASES) {
    const root = temp();
    const { board, workflow } = specOf(c);
    writeFileSync(join(root, "process.json"), JSON.stringify({ ...board, root: "." }));
    writeFileSync(join(root, "workflow.json"), JSON.stringify(workflow));
    const res = spawnSync(
      "node",
      [BOARD, "check", "--root", root, "--process", join(root, "process.json")],
      {
        encoding: "utf8",
      },
    );
    assert.equal(res.status, 2, c.name);
    const label = c.file === "workflow.json" ? "the workflow file" : "the process file";
    assert.match(res.stderr, new RegExp(`${c.file}: cannot use ${label}`), c.name);
    for (const path of c.bad) assert.ok(res.stderr.includes(`${path} `), `${c.name}: ${path}`);
  }
});

test("the pinned refusal texts: the lifecycle kind, no lifecycle, a parent field", () => {
  const messages = (name) =>
    validateSpec(specOf(ACROSS_CASES.find((c) => c.name === name))).problems.map((p) => p.message);
  assert.deepEqual(messages("the lifecycle kind as an exec kind"), [
    "exec.kinds.task is the lifecycle kind already",
  ]);
  assert.match(messages("exec kinds with no lifecycle")[0], /^exec\.kinds needs lifecycle/);
  assert.deepEqual(messages("an exec kind with a parent field"), [
    'exec.kinds.debt the debt kind has a parent field "of"; a kind exec runs beside the lifecycle has none',
  ]);
});

test("an exec kind listed through another kind's children field is refused; its own children list is not the reason", () => {
  const messages = (name) =>
    validateSpec(specOf(ACROSS_CASES.find((c) => c.name === name))).problems.map((p) => p.message);
  assert.deepEqual(messages("an exec kind that another kind lists as children"), [
    "exec.kinds.debt the debt kind is listed as children of chore; a kind exec runs beside the lifecycle stands alone",
  ]);
  // The parent side keeps the rule it had: a children field of its own changes nothing.
  assert.deepEqual(messages("an exec kind with a children list of its own"), [
    "exec.kinds.debt the debt kind is the parent of chore; a kind exec runs beside the lifecycle stands alone",
  ]);
});

test("the accessors: the runnable kinds, each kind's mapping, a flag read from the kind asked", () => {
  const { spec, model } = load(FIXTURE);
  assert.deepEqual(runKinds(spec), ["task", "debt"]);
  assert.deepEqual(runKinds(withoutDebt(structuredClone(spec))), ["task"]);
  assert.deepEqual(runKinds({ ...spec, lifecycle: undefined }), []);
  assert.deepEqual(lifecycleOf(spec, "debt"), { kind: "debt", ...spec.exec.kinds.debt });
  assert.equal(lifecycleOf(spec, "task").kind, "task");
  assert.equal(lifecycleOf(spec, "question"), null);
  assert.equal(lifecycleOf({ ...spec, lifecycle: undefined }, "debt"), null);
  const flagged = structuredClone(spec);
  flagged.kinds.debt.fields.flag = { column: "What", type: "flag" };
  const board = readProcess({ root: FIXTURE, spec: flagged });
  assert.equal(flaggedItem(flagged, board, "DEBT-1", "debt"), true);
  assert.equal(flaggedItem(flagged, board, "DEBT-1"), false); // the lifecycle's kind by default
  assert.equal(flaggedItem(spec, model, "DEBT-1", "debt"), false);
});

// ---- ids ------------------------------------------------------------------------------------------

test("runId: a unique id, any case, the kind that holds it", () => {
  const { spec, model } = load(FIXTURE);
  assert.deepEqual(runId(spec, model, "DEBT-3"), { id: "DEBT-3", kind: "debt" });
  assert.deepEqual(runId(spec, model, "debt-2"), { id: "DEBT-2", kind: "debt" });
  assert.deepEqual(runId(spec, model, "t2"), { id: "T2", kind: "task" });
});

test("runId: an id two kinds hold is the error, naming both", () => {
  const root = copy((text) => text.replace("| DEBT-3 |", "| T2 |"));
  const { spec, model } = load(root);
  assert.deepEqual(runId(spec, model, "t2"), { error: '"t2" names a task and a debt' });
});

test("runId: an id no kind holds is the lifecycle kind's spelling, as before; no lifecycle is task", () => {
  const { spec, model } = load(FIXTURE);
  assert.deepEqual(runId(spec, model, "DEBT-9"), { id: "DEBT-9", kind: "task" });
  assert.deepEqual(runId(spec, model, "Q1"), { id: "Q1", kind: "task" });
  const off = { ...spec, lifecycle: undefined, exec: undefined };
  assert.deepEqual(runId(off, model, "t2"), { id: "T2", kind: "task" });
  assert.deepEqual(runId(off, model, "debt-1"), { id: "debt-1", kind: "task" });
});

test("board lifecycle refuses an id two kinds hold with exit 2, writing nothing", () => {
  const root = copy((text) => text.replace("| DEBT-3 |", "| T2 |"));
  const before = boardText(root);
  const res = spawnSync(
    "node",
    [
      BOARD,
      "lifecycle",
      "built",
      "t2",
      "--apply",
      "--root",
      root,
      "--process",
      join(root, "process.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 2);
  assert.match(res.stderr, /"t2" names a task and a debt/);
  assert.equal(boardText(root), before);
});

test("board lifecycle resolves a debt id and writes only the debt row's cell", () => {
  const root = copy();
  const before = boardText(root);
  const res = spawnSync(
    "node",
    [
      BOARD,
      "lifecycle",
      "dispatched",
      "debt-1",
      "--apply",
      "--root",
      root,
      "--process",
      join(root, "process.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^lifecycle dispatched DEBT-1: 1 written/);
  assert.deepEqual(changedLines(before, boardText(root)), [
    "| DEBT-1 | Drop the old flag | doing |  |  |",
  ]);
});

// ---- writes ---------------------------------------------------------------------------------------

test("a debt write changes only the debt row's cells; DEBT-1 never writes DEBT-10's row", () => {
  const root = copy();
  const { spec, model } = load(root);
  const before = boardText(root);
  applyEvent({
    root,
    spec,
    model,
    event: "verdict",
    id: "DEBT-1",
    kind: "debt",
    data: { verdict: "FAIL" },
  });
  assert.deepEqual(changedLines(before, boardText(root)), [
    "| DEBT-1 | Drop the old flag | doing | FAIL |  |",
  ]);
});

test("applyEvent refuses a kind exec does not run, writing nothing; lifecycle off still skips", () => {
  const root = copy();
  const { spec, model } = load(root);
  const before = boardText(root);
  assert.throws(
    () => applyEvent({ root, spec, model, event: "dispatched", id: "Q1", kind: "question" }),
    (e) =>
      e instanceof WriteError &&
      e.message === '"question" is not a kind exec runs (lifecycle.kind or exec.kinds)',
  );
  assert.equal(boardText(root), before);
  const off = { ...spec, lifecycle: undefined };
  assert.deepEqual(
    applyEvent({ root, spec: off, model, event: "dispatched", id: "DEBT-1", kind: "debt" }),
    { writes: [], skipped: [{ what: "status", why: "lifecycle off" }] },
  );
});

test("strayChanges: a debt lane's cells and a task lane's cells are both lifecycle cells", () => {
  const { spec } = load(FIXTURE);
  const cell = (kind, id, field) => ({
    kind,
    id,
    field,
    file: "BOARD.md",
    line: 1,
    from: "a",
    to: "b",
  });
  const diff = {
    other: [],
    cells: [
      cell("debt", "DEBT-1", "status"),
      cell("task", "T2", "verdict"),
      cell("debt", "DEBT-1", "what"),
    ],
  };
  assert.deepEqual(strayChanges(spec, diff, { ids: ["DEBT-1", "T2"] }), [
    'BOARD.md:1: debt DEBT-1 what "a" → "b" is not a lifecycle cell',
  ]);
  assert.deepEqual(
    strayChanges(spec, { other: [], cells: diff.cells.slice(0, 1) }, { ids: ["T2"] }),
    ['BOARD.md:1: debt DEBT-1 status "a" → "b", but DEBT-1 has no open lane'],
  );
  const off = withoutDebt(structuredClone(spec));
  assert.match(
    strayChanges(off, { other: [], cells: diff.cells.slice(0, 1) }, { ids: ["DEBT-1"] })[0],
    /is not a lifecycle cell/,
  );
});

// ---- status ---------------------------------------------------------------------------------------

const view = (board) => statusView({ root: board.root, spec: board.spec, model: board.model });
const render = (board, v = view(board)) =>
  renderStatus({
    spec: board.spec,
    report: boardReport(board),
    view: v,
    work: workKind(board.spec),
  });

test("side counts the debt kind on its own: open, active, done", () => {
  const v = view(load(copy()));
  assert.deepEqual(v.side, [
    { kind: "debt", label: "Debt", open: 2, active: [{ id: "DEBT-3", status: "doing" }], done: 1 },
  ]);
});

test("debt is in no sprint's count, nor in flight, on you, blocked, ahead or parked", () => {
  const root = copy();
  const v = view(load(root));
  const bare = view(load(root, withoutDebt));
  assert.deepEqual(v.side.length, 1);
  assert.deepEqual(bare.side, []);
  for (const key of ["now", "inFlight", "onYou", "blocked", "ahead", "parked"])
    assert.deepEqual(v[key], bare[key], key);
  const ids = JSON.stringify([v.inFlight, v.onYou, v.now, v.ahead, v.blocked]);
  assert.doesNotMatch(ids, /DEBT/);
  assert.deepEqual(
    v.onYou.map((x) => x.id),
    ["Q1"],
  );
});

test("the Debt row follows On you, with its exact text", () => {
  const lines = render(load(copy())).split("\n");
  const at = lines.findIndex((l) => l.startsWith("On you"));
  assert.equal(lines[at + 1], "Debt       2 open · DEBT-3 doing · 1 done");
});

test("four active debt items show three, then +1", () => {
  const root = copy((text) =>
    text
      .replace("| DEBT-1 | Drop the old flag | todo |", "| DEBT-1 | Drop the old flag | doing |")
      .replace("| DEBT-10 | Retire the shim | cut |", "| DEBT-10 | Retire the shim | verify |")
      .replace("| DEBT-2 | Rename the helper | done |", "| DEBT-2 | Rename the helper | doing |"),
  );
  const row = render(load(root))
    .split("\n")
    .find((l) => l.startsWith("Debt "));
  assert.equal(row, "Debt       4 open · DEBT-1 doing · DEBT-2 doing · DEBT-3 doing · +1 · 0 done");
});

test("a clean board with no open debt has no Debt row; with the debt open it has one", () => {
  const closed = (text) =>
    text
      .replace("| DEBT-1 | Drop the old flag | todo |", "| DEBT-1 | Drop the old flag | done |")
      .replace("| DEBT-3 | Split the reader | doing |", "| DEBT-3 | Split the reader | cut |");
  const board = load(copy(closed));
  assert.equal(boardReport(board).ok, true);
  assert.deepEqual(view(board).side[0].open, 0);
  assert.doesNotMatch(render(board), /^Debt /m);
  assert.match(render(load(copy())), /^Debt {7}2 open/m);
});

// ---- the format reference and the docs ------------------------------------------------------------

test('format.md: the exec row names kinds, and the "exec kinds" table lists the entry\'s keys', () => {
  const text = readFileSync(join(PLUGIN, "skills", "process", "references", "format.md"), "utf8");
  const top = md.tableIn(text, md.section(text, "workflow.json: top level"));
  const exec = top.rows.find((r) => md.plain(r.cells.Key) === "exec");
  assert.match(exec.cells.What, /`kinds`/);
  const sec = md.section(text, "exec kinds");
  assert.ok(sec, 'format.md has an "exec kinds" section');
  const table = md.tableIn(text, sec);
  const rows = table.rows.map((r) => [md.plain(r.cells.Key), md.plain(r.cells.Required)]);
  const keyRows = (keys, at) =>
    Object.entries(keys).flatMap(([key, check]) => {
      const path = `${at}${key.replace(/!$/, "")}`;
      return [
        [path, key.endsWith("!") ? "yes" : "no"],
        ...(check.keys ? keyRows(check.keys, `${path}.`) : []),
      ];
    });
  assert.deepEqual(rows, [["exec.kinds.<kind>", "no"], ...keyRows(execKindSchema.keys, "")]);
});

test("the commands and references name debt ids where they say task", () => {
  for (const file of [
    "commands/new.md",
    "commands/exec.md",
    "commands/merge.md",
    "skills/process/references/learn.md",
    "skills/conducting/references/lanes.md",
    "skills/conducting/references/merge.md",
  ])
    assert.match(readFileSync(join(PLUGIN, file), "utf8"), /DEBT-\d/, file);
});
