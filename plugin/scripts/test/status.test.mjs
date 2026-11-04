// Tests for lib/process/status.mjs (the checked board and its derived view) and lib/process/render.mjs
// (the terminal text), on the synthetic fixtures. Their invented commits exist in no repository.
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { add as addDraft } from "../lib/process/drafts.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import { WIDTH, renderCheck, renderStatus, renderWhy, wrapText } from "../lib/process/render.mjs";
import { boardReport, statusView, workKind } from "../lib/process/status.mjs";
import { boardRepo, handBranch } from "./drift-repo.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const copies = [];
after(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});
// A copy of the fixture outside any repository: a board in a subfolder sees its repository's worktrees, and
// the view must not depend on the ones the checkout running the tests happens to have.
function copyOf(name) {
  const root = mkdtempSync(join(tmpdir(), "agentry-status-"));
  copies.push(root);
  cpSync(join(FIXTURES, name), root, { recursive: true });
  return root;
}
function board(name, root = copyOf(name)) {
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

test("the report checks 2,000 done rows' commits in well under a second", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-status-"));
  try {
    const rows = Array.from({ length: 2000 }, (_, i) => {
      const sha = (0xabc0000 + i).toString(16);
      return `| T${i} | done | ${sha} |`;
    });
    const md = ["## Tasks", "", "| Task | Status | Commit |", "| --- | --- | --- |", ...rows];
    writeFileSync(join(root, "BOARD.md"), `${md.join("\n")}\n`);
    const task = {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" }, commit: { column: "Commit", type: "commits" } },
      status: { field: "status", values: { done: "done" } },
    };
    const rules = [
      { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" },
    ];
    const spec = { version: 1, name: "Big", root: ".", kinds: { task }, rules };
    const model = readProcess({ root, spec });
    const start = performance.now();
    const report = boardReport({ root, spec, model });
    const ms = performance.now() - start;
    assert.equal(report.findings.length, 2000, "outside a repository no commit is found");
    assert.ok(ms < 1000, `boardReport took ${Math.round(ms)} ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    const { writtenAt, ...rest } = view.note;
    assert.deepEqual(rest, {
      path: "NOTE.md",
      lines: ["Read the gate first.", "Then the docs."],
      now: ["K0"],
      old: false,
    });
    assert.match(writtenAt, /^\d{4}-\d\d-\d\dT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A copy of the evidence board (its Now is K0) with NOTE.md written `hours` ago, by its mtime.
function noted(text, hours = 0) {
  const { root, spec, model } = board("evidence-board");
  const when = new Date(Math.floor((Date.now() - hours * 3_600_000) / 1000) * 1000);
  writeFileSync(join(root, "NOTE.md"), text);
  utimesSync(join(root, "NOTE.md"), when, when);
  return { root, spec: { ...spec, status: { note: "NOTE.md" } }, model, when };
}
const seen = (root, text) => {
  mkdirSync(join(root, ".agentry", "run"), { recursive: true });
  writeFileSync(join(root, ".agentry", "run", "note-seen.json"), text);
};

test("the note's writtenAt is the file's mtime and now the Now active at a first read", () => {
  const { when, ...ctx } = noted("Read the gate first.\n", 3);
  const { note } = statusView(ctx);
  assert.equal(note.writtenAt, when.toISOString());
  assert.deepEqual(note.now, ["K0"]);
});

test("a note 12 h old or more is old, one under is not, whatever clock its text names", () => {
  assert.equal(statusView(noted("Fresh.\n", 12)).note.old, true);
  assert.equal(statusView(noted("Fresh.\n", 11.9)).note.old, false);
  const dated = noted("Written 2020-01-01 09:00, three years back.\n");
  assert.equal(statusView(dated).note.old, false, "the age is the mtime's, not the text's");
});

test("a note read under another Now than the one recorded for its mtime is stale by sprint", () => {
  const { when, ...ctx } = noted("Watch K1a.\n", 30);
  seen(ctx.root, JSON.stringify({ mtime: when.toISOString(), now: ["K9"] }));
  const { note } = statusView(ctx);
  assert.deepEqual(note.now, ["K9"], "now is what was active when it was written");
  assert.deepEqual(note.stale, { why: "now-changed", was: ["K9"], now: ["K0"] });
  // Recorded for the same Now: not stale.
  seen(ctx.root, JSON.stringify({ mtime: when.toISOString(), now: ["K0"] }));
  assert.equal(statusView(ctx).note.stale, undefined);
});

test("a first read is never stale by sprint: no record, one for another mtime, or one it cannot read", () => {
  const ctx = noted("Watch K1a.\n", 30);
  assert.equal(statusView(ctx).note.stale, undefined);
  seen(ctx.root, JSON.stringify({ mtime: "2020-01-01T00:00:00.000Z", now: ["K9"] }));
  assert.equal(statusView(ctx).note.stale, undefined);
  assert.deepEqual(statusView(ctx).note.now, ["K0"]);
  for (const bad of ["{", "[]", JSON.stringify({ mtime: 3, now: "K9" })]) {
    seen(ctx.root, bad);
    const { note } = statusView(ctx);
    assert.equal(note.stale, undefined, bad);
    assert.deepEqual(note.now, ["K0"], bad);
  }
});

test("the view writes no note record: only lane session start does", () => {
  const ctx = noted("Read the gate first.\n");
  statusView(ctx);
  assert.throws(() => readFileSync(join(ctx.root, ".agentry", "run", "note-seen.json")), {
    code: "ENOENT",
  });
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

test("a clean board: check is the verdict alone; status adds Now and On you", () => {
  const { root, spec, model, report, work } = board("table-board");
  assert.equal(renderCheck({ spec, report, work }), "✓ Sample  OK · 8 rules · 8 tasks · exit 0");
  // Without a lifecycle nothing says a task was started by hand, so no drift rows.
  const view = statusView({ root, spec: { ...spec, lifecycle: undefined }, model });
  const lines = renderStatus({ spec, report, view, work, subtitle: "x" }).split("\n");
  assert.equal(lines[0], "✓ Sample  OK · 8 rules · 8 tasks · exit 0");
  assert.equal(lines[1], "");
  assert.ok(
    lines.some((l) => /^On you {5}/.test(l)),
    "On you is always shown",
  );
  assert.ok(
    lines.slice(2).every((l) => /^(Now|On you|Blocked|Ahead| {11})/.test(l)),
    "no In flight, no findings",
  );
});

test("a clean board shows Blocked and Ahead when they are not empty, a few, then +N more", () => {
  const { spec, report, work } = board("table-board");
  const ahead = ["A", "B", "C", "D", "E", "F"].map((id) => ({ id, done: 0, total: 2 }));
  const view = {
    now: [],
    inFlight: [],
    onYou: [{ kind: "question", id: "Q1", status: "open" }],
    blocked: [{ id: "T9", by: ["T1"] }],
    ahead,
    parked: 2,
    nudges: [],
    drafts: 0,
  };
  const text = renderStatus({ spec, report, view, work });
  assert.match(text, /^Blocked {4}1 waiting: 1 behind T1$/m);
  assert.match(text, /^Ahead {6}A 0\/2 · B 0\/2 · C 0\/2 · D 0\/2 · \+2 more · 2 parked$/m);
  assert.ok(cols(text) <= WIDTH);
});

test("ahead leaves out a sprint that holds only parked rows; the parked count has them", () => {
  const root = copyOf("evidence-board");
  const file = join(root, "notes", "release", "BOARD.md");
  const md = readFileSync(file, "utf8").replace(
    "| K1b | Reports | todo | |",
    "$&\n| LATER | Later | todo | |",
  );
  writeFileSync(file, md);
  const { spec, model } = board("evidence-board", root);
  const view = statusView({ root, spec, model });
  assert.deepEqual(
    view.ahead.map((a) => a.id),
    ["K1a", "K1b"],
  );
  assert.equal(view.parked, 1);
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

test("a long finding wraps onto indented lines at word breaks, never cut", () => {
  const long =
    "verify, but depends on F13-T2 (task, verify) and on a second item that is also waiting";
  const findings = [
    { rule: "deps-done", kind: "task", id: "F13-T4", message: long, file: "BOARD.md", line: 49 },
    { rule: "read", kind: "task", message: 'BOARD.md: the "Tasks" table has no column "Status"' },
  ];
  const report = { ok: false, name: "Long", rules: 1, items: { task: 1 }, findings };
  const spec = { rules: [{ rule: "deps-done" }] };
  const lines = renderCheck({ spec, report, work: "task" }).split("\n");
  assert.match(lines[0], /^✗ Long {2}2 problems · .* · exit 1$/);
  assert.ok(
    lines.every((l) => [...l].length <= WIDTH),
    lines.join("\n"),
  );
  assert.ok(!lines.some((l) => l.includes("…")), "nothing is cut");
  const first = lines.findIndex((l) => l.includes("F13-T4"));
  assert.match(lines[first], /BOARD\.md:49$/, "the location stays on the first line");
  const indent = lines[first].indexOf("verify");
  const next = lines.findIndex((l, n) => n > first && !/^ +\S/.test(l));
  const rest = lines.slice(first + 1, next);
  assert.ok(rest.length > 0 && rest.every((l) => l.search(/\S/) === indent), "continuations align");
  const text = [
    lines[first].slice(indent).replace(/\s+BOARD\.md:49$/, ""),
    ...rest.map((l) => l.trim()),
  ];
  assert.equal(text.join(" "), long);
  assert.ok(
    lines.some((l) => /(^| )"Status"$/.test(l)),
    "the read problem ends whole",
  );
});

test("a continuation line uses the full width, so a 39-character path stays whole", () => {
  const path = "sprints/P2b_getaway_legend_build_001.md";
  assert.equal(path.length, 39);
  const message = `the sprint file is missing: expected ${path} but found nothing there at all`;
  const findings = [{ rule: "file-exists", id: "P2b", message, file: "BOARD.md", line: 49 }];
  const report = { ok: false, name: "W", rules: 1, items: { task: 1 }, findings };
  const lines = renderCheck({ spec: { rules: [] }, report, work: "task" }).split("\n");
  assert.ok(
    lines.some((l) => l.includes(path)),
    lines.join("\n"),
  );
  assert.ok(
    lines.every((l) => [...l].length <= WIDTH),
    lines.join("\n"),
  );
});

test("wrapText gives later lines their own width and lets a long word overflow them", () => {
  assert.deepEqual(wrapText("aa bb cc dd ee", 5, 8), ["aa bb", "cc dd ee"]);
  assert.deepEqual(wrapText("aa bbbbbbbbbbbb cc", 5, 8), ["aa", "bbbbbbbbbbbb", "cc"]);
});

test("--why wraps a long finding the same way", () => {
  const long =
    "verify, but depends on F13-T2 (task, verify) and on a second item that is also waiting";
  const item = { kind: "task", id: "X1", file: "B.md", line: 3, fields: {} };
  const spec = { kinds: { task: { fields: {} } }, rules: [{ rule: "deps-done" }] };
  const report = { findings: [{ rule: "deps-done", kind: "task", id: "X1", message: long }] };
  const lines = renderWhy({ spec, model: { index: { X1: [item] } }, report, id: "X1" }).split("\n");
  const at = lines.findIndex((l) => l.startsWith("✗ deps-done  verify,"));
  assert.ok(
    lines.every((l) => [...l].length <= WIDTH && !l.includes("…")),
    lines.join("\n"),
  );
  assert.equal(
    lines
      .slice(at)
      .map((l) => l.replace(/^✗ deps-done/, "").trim())
      .join(" "),
    long,
  );
});

test("wrapText breaks between words and splits only a word wider than the column", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("", 4), [""]);
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

test("--why says what an item is blocked by, before the rules that hold", () => {
  const { spec, model, report } = board("evidence-board");
  const lines = renderWhy({ spec, model, report, id: "H2" }).split("\n");
  const blocked = lines.indexOf("blocked by: K0, H1");
  assert.ok(blocked > 0, lines.join("\n"));
  assert.ok(blocked < lines.findIndex((l) => l.startsWith("✓")));
  const done = renderWhy({ spec, model, report, id: "K0-1" });
  assert.ok(!done.includes("blocked by"));
});

// Drift and drafts in the view: a temp repo with a hand worktree, a started task, a pending draft.
function driftView(extra = () => {}) {
  const repo = boardRepo();
  after(repo.cleanup);
  const { root } = repo;
  const { spec } = loadSpec(join(root, ".agentry", "process.json"), { root });
  extra(root);
  const model = readProcess({ root, spec });
  const report = boardReport({ root, spec, model });
  const view = statusView({ root, spec, model });
  return { root, spec, report, view, work: workKind(spec) };
}

test("tasks the board started with no ledger nudge; a board with no lifecycle has none", () => {
  const { root, spec, model } = board("table-board");
  const view = statusView({ root, spec, model });
  assert.deepEqual(
    view.nudges.map((n) => [n.kind, n.id, n.command]),
    [
      ["started-by-hand", "W3", "/agentry:exec W3"],
      ["started-by-hand", "X-01", "/agentry:exec X-01"],
    ],
  );
  assert.equal(view.drafts, 0);
  assert.deepEqual(statusView({ root, spec: { ...spec, lifecycle: undefined }, model }).nudges, []);
});

test("the view carries nudges and the pending draft count, and status shows both", () => {
  const { spec, report, view, work } = driftView((root) => {
    handBranch(root, ".claude/worktrees/agent-q1", "worktree-agent-q1");
    addDraft(root, { kind: "rule", answer: "Recall first." });
  });
  assert.deepEqual(
    view.nudges.map((n) => n.kind),
    ["unlisted-worktree", "started-by-hand", "started-by-hand"],
  );
  assert.equal(view.drafts, 1);
  const text = renderStatus({ spec, report, view, work });
  assert.match(
    text,
    /^Drift {6}! unlisted-worktree agent-q1 → land: lane merge <id> --branch\n {13}worktree-agent-q1 · continue: lane exec adopt <id> --branch\n/m,
  );
  assert.match(text, /^ {13}<id>\|--keep "<why>" · remove: git worktree remove$/m);
  assert.match(text, /^ {13}\.claude\/worktrees\/agent-q1$/m);
  assert.doesNotMatch(text, /unlisted-worktree[^\n]*\/agentry:exec/);
  assert.match(text, /^ {11}! started-by-hand T1 → \/agentry:exec T1$/m);
  assert.match(text, /^Drafts {5}1 pending · \/agentry:board draft list$/m);
});

test("a worktree matching worktrees.keep shows as Kept and is not drift", () => {
  const kept = driftView((root) => {
    handBranch(root, ".claude/worktrees/agent-keep", "worktree-agent-keep");
    handBranch(root, ".claude/worktrees/agent-q1", "worktree-agent-q1");
  });
  assert.deepEqual(
    kept.view.nudges.filter((n) => n.kind === "unlisted-worktree").map((n) => n.branch),
    ["worktree-agent-keep", "worktree-agent-q1"],
  );
  const spec = { ...kept.spec, worktrees: { keep: ["agent-ke?p", "nothing-*"] } };
  const view = statusView({ root: kept.root, spec, model: readProcess({ root: kept.root, spec }) });
  assert.deepEqual(
    view.nudges.filter((n) => n.kind === "unlisted-worktree").map((n) => n.branch),
    ["worktree-agent-q1"],
  );
  assert.deepEqual(
    view.kept.map((k) => k.branch),
    ["worktree-agent-keep"],
  );
  assert.match(renderStatus({ ...kept, spec, view }), /^Kept {7}agent-keep$/m);
});

test("a hand status file listing a done task under its heading draws one nudge", () => {
  const base = driftView((root) => {
    const file = join(root, "plan", "BOARD.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("| T2   | S1     | todo", "| T2   | S1     | done"),
    );
    writeFileSync(
      join(root, "STATUS.md"),
      "# Status\n\n## Next\n\n- T1 the first\n- T2 the second\n\n## Later\n\n- T2 mentioned again\n",
    );
  });
  const spec = { ...base.spec, status: { file: "STATUS.md", next: "Next" } };
  const model = readProcess({ root: base.root, spec });
  const view = statusView({ root: base.root, spec, model });
  const stale = view.nudges.filter((n) => n.kind === "stale-status");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].command, "edit STATUS.md: T2 done on the board");
  const report = boardReport({ root: base.root, spec, model });
  assert.match(
    renderStatus({ spec, report, view, work: base.work }),
    /^ +! stale-status STATUS\.md → edit/m,
  );
  const none = { ...spec, status: { file: "STATUS.md", next: "Later later" } };
  assert.equal(
    statusView({ root: base.root, spec: none, model }).nudges.filter(
      (n) => n.kind === "stale-status",
    ).length,
    0,
    "a heading that is not in the file draws nothing",
  );
});

test("with more than four nudges the rest are counted, and no line passes 80 columns", () => {
  const { spec, report, view, work } = driftView((root) => {
    for (const n of ["a", "b", "c", "d"])
      handBranch(root, `.claude/worktrees/agent-${n}${"x".repeat(60)}`, `worktree-agent-${n}`);
  });
  assert.ok(view.nudges.length > 4);
  const text = renderStatus({ spec, report, view, work });
  assert.match(text, new RegExp(`^ {11}\\+${view.nudges.length - 4} more: /agentry:board$`, "m"));
  // A line passes 80 columns only when what is on it is one word too wide to wrap (a worktree's path).
  for (const line of text.split("\n"))
    assert.ok([...line].length <= WIDTH || /^ *\S+$/.test(line), line);
  assert.ok(text.replaceAll(/\s+/g, " ").includes("remove: git worktree remove .claude/"), text);
  const tty = renderStatus({ spec, report, view, work, tty: true });
  assert.ok(tty.includes(`${ESC}[36m!${ESC}[0m`), "only the glyph is colored");
});

test("a nudge wider than its row wraps between words: the command is whole", () => {
  const { spec, report, view, work } = driftView();
  const branch = "worktree-agent-a1b23d1ce1f7e212b";
  const command = `/agentry:merge T7 --branch ${branch}, then /agentry:board --fix --accept T7`;
  const nudges = [{ kind: "merged-by-hand", id: "T7", branch, command }];
  const text = renderStatus({ spec, report, view: { ...view, nudges }, work });
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Drift      ! merged-by-hand T7 → "));
  assert.ok(at >= 0, text);
  assert.match(lines[at + 1], /^ {13}\S/, "the rest indented under the row");
  const joined = lines
    .slice(at, at + 3)
    .join(" ")
    .replace(/\s+/g, " ");
  assert.ok(joined.includes(command), text);
  assert.ok(cols(text) <= WIDTH, text);
});
