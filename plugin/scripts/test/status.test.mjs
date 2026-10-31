// Tests for lib/process/status.mjs (the checked board and its derived view) and lib/process/render.mjs
// (the terminal text), on the synthetic fixtures. Their invented commits exist in no repository.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import { WIDTH, renderCheck, renderStatus, renderWhy } from "../lib/process/render.mjs";
import { boardReport, statusView, workKind } from "../lib/process/status.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
function board(name, root = join(FIXTURES, name)) {
  const { spec } = loadSpec(join(FIXTURES, name, "process.json"));
  const model = readProcess({ root, spec });
  return { root, spec, model, report: boardReport({ root, spec, model }), work: workKind(spec) };
}
const ESC = String.fromCharCode(27);
const cols = (text) => Math.max(...text.split("\n").map((l) => [...l].length));

test("the report counts items per kind and carries load problems and rule findings", () => {
  const { report } = board("evidence-board");
  assert.equal(report.ok, false);
  assert.equal(report.items.task, 8);
  assert.equal(report.rules, 6);
  assert.ok(report.findings.some((f) => f.rule === "deps-done" && f.id === "H2"));
});

test("the view: now with progress, in flight, on you, blocked, ahead and parked", () => {
  const { root, spec, model } = board("evidence-board");
  const view = statusView({ root, spec, model });
  assert.deepEqual(
    view.now.map((n) => [n.id, n.name, n.status, n.done, n.total, n.tally.verify]),
    [["K0", "Groundwork", "doing", 3, 4, 1]],
  );
  assert.deepEqual(view.inFlight, [
    { id: "K0-4", status: "verify" },
    { id: "H2", status: "doing" },
  ]);
  assert.deepEqual(view.onYou, [
    { kind: "task", id: "K0-4", status: "verify" },
    { kind: "question", id: "Q2", status: "open" },
  ]);
  assert.deepEqual(view.blocked, [
    { id: "H1", by: ["K0"] },
    { id: "H3", by: ["K1"] },
  ]);
  assert.deepEqual(
    view.ahead.map((a) => a.id),
    ["K1a", "K1b"],
  );
  assert.equal(view.parked, 1);
});

test("the view reads the note file when there is one", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-status-"));
  try {
    cpSync(join(FIXTURES, "evidence-board"), root, { recursive: true });
    writeFileSync(join(root, "NOTE.md"), "Read the gate first.\nThen the docs.\n");
    const { spec, model } = board("evidence-board", root);
    const view = statusView({ root, spec: { ...spec, status: { note: "NOTE.md" } }, model });
    assert.deepEqual(view.note, {
      path: "NOTE.md",
      lines: ["Read the gate first.", "Then the docs."],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check: line 1 is the verdict with the exit code, then one line per finding", () => {
  const { spec, report, work } = board("evidence-board");
  const lines = renderCheck({ spec, report, work }).split("\n");
  assert.equal(lines[0], "✗ Release  5 problems · 6 rules · 8 tasks · exit 1");
  const finding = lines.find((l) => l.includes("H2"));
  assert.match(
    finding,
    /^✗ deps-done\s+H2\s+doing, but depends on K0 \(sprint, doing\)\s+BOARD\.md:27$/,
  );
  assert.match(lines.at(-1), /^\d+ rules hold · --why <id>$/);
});

test("a clean board: check is the verdict alone; status adds only the Now block", () => {
  const { root, spec, model, report, work } = board("table-board");
  assert.equal(renderCheck({ spec, report, work }), "✓ Sample  OK · 8 rules · 8 tasks · exit 0");
  const view = statusView({ root, spec, model });
  const lines = renderStatus({ spec, report, view, work, subtitle: "x" }).split("\n");
  assert.equal(lines[0], "✓ Sample  OK · 8 rules · 8 tasks · exit 0");
  assert.equal(lines[1], "");
  assert.ok(
    lines.slice(2).every((l) => /^(Now| {11})/.test(l)),
    "only Now rows follow",
  );
});

test("status: the blocks in order, findings, the legend; no line wider than the terminal", () => {
  const { root, spec, model, report, work } = board("evidence-board");
  const view = statusView({ root, spec, model });
  const text = renderStatus({ spec, report, view, work, subtitle: "notes/release · process.json" });
  const labels = text
    .split("\n")
    .map((l) => l.slice(0, 11).trim())
    .filter((l) => /^[A-Z]/.test(l));
  assert.deepEqual(labels, ["Release", "Now", "In flight", "On you", "Blocked", "Ahead"].slice(1));
  assert.match(text, /^On you {5}◆ K0-4 {2}\? Q2 open$/m);
  assert.match(text, /^■ done {2}◆ verify/m);
  assert.ok(cols(text) <= WIDTH);
  assert.ok(!text.includes(ESC), "no color off a TTY");
});

test("color sits on glyphs only, on a TTY", () => {
  const { spec, report, work } = board("evidence-board");
  const text = renderCheck({ spec, report, work, tty: true });
  assert.ok(text.includes(`${ESC}[31m✗${ESC}[0m`));
  const colored = text.split(ESC).filter((s) => /^\[3\dm/.test(s));
  assert.ok(colored.length > 0);
  for (const s of colored) assert.match(s, /^\[3\dm[✗✓◆?■]+$/, "only glyphs are colored");
});

test("--why traces one item: where it sits, the rule that fails, the rules that hold", () => {
  const { spec, model, report } = board("evidence-board");
  const lines = renderWhy({ spec, model, report, id: "H2" }).split("\n");
  assert.equal(lines[0], "H2  Second lane");
  assert.match(lines[1], /BOARD\.md:27 · task · sprint K1a \(todo\) · status doing/);
  assert.ok(lines.some((l) => /^✗ deps-done {2}doing, but depends on H1/.test(l)));
  assert.ok(lines.some((l) => /^✓ ids-unique · refs-resolve/.test(l)));
});
