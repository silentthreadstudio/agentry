// board-view proof (doc 18 slice 2) — the drop rules and card view-logic.
//
// The rule worth pinning is why a RUN card cannot be dragged. A run's column is derived from its tasks,
// so moving its card would ask the board to display something the run is not doing. The refusal is a
// message, not a silent spring-back — a board that ignores you teaches nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardCard, RunDoc } from "@agentry/workbench-shared";
import {
  COLUMNS,
  assignedByAgent,
  blockedLabel,
  canDrop,
  cardNote,
  conflictText,
  countChips,
  currentTask,
  docTabLabel,
  elapsedOf,
  initialsOf,
  isReset,
  keyboardTarget,
  progressOf,
  refusalReason,
  relativeTime,
  resetPrompt,
  totalCards,
} from "../routes/board/board-view.js";

const item = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: "b-1",
  column: "backlog",
  title: "An item",
  origin: "item",
  updatedAt: "2026-08-22T00:00:00.000Z",
  ...over,
});

const run = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: "r-1",
  column: "running",
  title: "A run",
  origin: "run",
  run: "r-1",
  taskCounts: { todo: 1, "in-progress": 1, "in-review": 0, done: 2 },
  agentCount: 1,
  updatedAt: "2026-08-22T00:00:00.000Z",
  ...over,
});

test("the columns read left to right in lifecycle order", () => {
  assert.deepEqual(
    COLUMNS.map((c) => c.key),
    ["backlog", "ready", "running", "in-review", "done"],
  );
});

test("an item moves between backlog and ready — the two states an item has", () => {
  assert.equal(canDrop(item(), "ready"), true);
  assert.equal(canDrop(item({ column: "ready" }), "backlog"), true);
});

test("an item cannot be dropped into a run column — it has no run to be in", () => {
  for (const col of ["running", "in-review", "done"] as const) {
    assert.equal(canDrop(item(), col), false);
  }
});

test("a run can only be dropped on Ready — that drop means RESET, not a move", () => {
  assert.equal(canDrop(run(), "ready"), true);
  for (const col of ["backlog", "running", "in-review", "done"] as const) {
    assert.equal(canDrop(run(), col), false);
  }
});

test("a run onto Ready is the reset path; an item onto Ready is not", () => {
  assert.equal(isReset(run(), "ready"), true);
  assert.equal(isReset(item(), "ready"), false);
  assert.equal(isReset(run(), "backlog"), false);
});

test("the reset prompt says what happens AND what does not — it is not a kill", () => {
  const text = resetPrompt(run({ title: "Session middleware" }));
  assert.match(text, /Session middleware/);
  assert.match(text, /to-do/);
  assert.match(text, /Nothing is deleted/);
  assert.match(text, /not stopped/, "'reset' reads like 'kill it' unless you say otherwise");
});

test("a refusal explains itself, and says something different for a run than for an item", () => {
  const forRun = refusalReason(run(), "done");
  const forItem = refusalReason(item(), "in-review");
  assert.match(forRun, /comes from its tasks/);
  assert.match(forRun, /Drop it on Ready/, "a refusal that names the one thing you CAN do");
  assert.match(forItem, /Backlog or Ready/);
  assert.match(forItem, /In review/, "the column's DISPLAY label, not the raw key");
  assert.notEqual(forRun, forItem);
});

test("progress is the done fraction of a run, and null for an item", () => {
  assert.equal(progressOf(run()), 0.5);
  assert.equal(progressOf(item()), null);
});

test("a run with zero tasks has no progress bar rather than a 0% or NaN one", () => {
  assert.equal(
    progressOf(run({ taskCounts: { todo: 0, "in-progress": 0, "in-review": 0, done: 0 } })),
    null,
  );
});

test("count chips omit the empty buckets and keep lifecycle order", () => {
  assert.deepEqual(countChips(run()), [
    { label: "in progress", n: 1 },
    { label: "to do", n: 1 },
    { label: "done", n: 2 },
  ]);
});

test("an item contributes no count chips", () => {
  assert.deepEqual(countChips(item()), []);
});

test("totalCards counts every column", () => {
  assert.equal(
    totalCards({
      backlog: [item()],
      ready: [],
      running: [run()],
      "in-review": [],
      done: [run(), run()],
    }),
    4,
  );
});

// ── presence + the two signals (slice 3) ───────────────────────────────────────────────────────────
test("initials come from the role, so the roster is scannable without a legend", () => {
  assert.equal(
    initialsOf({ id: "r/implementer", role: "implementer", state: "working", task: null }),
    "IM",
  );
  assert.equal(
    initialsOf({ id: "r/verifier", role: "verifier", state: "working", task: null }),
    "VE",
  );
});

test("elapsed reads compactly across the scales that matter", () => {
  const at = (msAgo: number) => ({
    id: "a",
    role: "implementer",
    state: "working" as const,
    task: null,
    since: new Date(1_000_000_000_000 - msAgo).toISOString(),
  });
  const now = 1_000_000_000_000;
  assert.equal(elapsedOf(at(5_000), now), "5s");
  assert.equal(elapsedOf(at(4 * 60_000), now), "4m");
  assert.equal(elapsedOf(at(3 * 3_600_000), now), "3h");
  assert.equal(elapsedOf(at(2 * 86_400_000), now), "2d");
});

test("no `since` means NO timer — an elapsed time with no start can only be invented", () => {
  assert.equal(elapsedOf({ id: "a", role: "implementer", state: "working", task: null }), null);
});

test("an unparseable `since` shows no timer rather than NaN", () => {
  assert.equal(
    elapsedOf({ id: "a", role: "x", state: "working", task: null, since: "not a date" }),
    null,
  );
});

test("a future `since` clamps to 0 rather than showing a negative age", () => {
  const now = 1_000_000_000_000;
  assert.equal(
    elapsedOf(
      {
        id: "a",
        role: "x",
        state: "working",
        task: null,
        since: new Date(now + 5000).toISOString(),
      },
      now,
    ),
    "0s",
  );
});

test("the conflict banner names the FILE and the runs — what breaks, and where to stop it", () => {
  const text = conflictText({
    files: ["auth/middleware.ts"],
    cards: ["r-a", "r-b"],
    tasks: ["r-a/001", "r-b/002"],
  });
  assert.match(text, /auth\/middleware\.ts/);
  assert.match(text, /r-a and r-b/);
  assert.match(text, /clobber/);
});

test("the blocked chip names the blocker rather than saying a bare 'blocked'", () => {
  assert.equal(blockedLabel(item({ blocked: [{ task: "002", by: ["001"] }] })), "blocked by 001");
});

test("more than one blocked task is summarised, not truncated silently", () => {
  const label = blockedLabel(
    item({
      blocked: [
        { task: "002", by: ["001"] },
        { task: "003", by: ["002"] },
      ],
    }),
  );
  assert.equal(label, "blocked by 001 (+1 more)");
});

test("a card with nothing blocked has no chip", () => {
  assert.equal(blockedLabel(item()), null);
});

// ── phase 1 screenshot-pass fixes ──────────────────────────────────────────────────────────────────
test("relativeTime reads at the scales a board actually spans", () => {
  const now = Date.parse("2026-08-23T12:00:00.000Z");
  const ago = (iso: string) => relativeTime(iso, now);
  assert.equal(ago("2026-08-23T11:59:40.000Z"), "just now");
  assert.equal(ago("2026-08-23T11:20:00.000Z"), "40m ago");
  assert.equal(ago("2026-08-22T15:00:00.000Z"), "21h ago");
  assert.equal(ago("2026-08-21T12:00:00.000Z"), "2d ago");
  assert.equal(ago("2026-06-21T12:00:00.000Z"), "2mo ago");
});

test("an unparseable timestamp yields no age rather than 'NaN ago'", () => {
  assert.equal(relativeTime("not a date"), "");
});

test("the note differs per column, because the useful fact differs", () => {
  const at = "2026-08-22T12:00:00.000Z";
  const now = Date.parse("2026-08-23T12:00:00.000Z");
  assert.match(cardNote(item({ column: "backlog", updatedAt: at }), now), /^added /);
  assert.equal(cardNote(item({ column: "ready", updatedAt: at }), now), "picks up next");
  assert.equal(cardNote(run({ column: "in-review", updatedAt: at }), now), "waiting on you");
  assert.match(cardNote(run({ column: "done", updatedAt: at }), now), /^shipped /);
});

test("a blocked run says it is waiting rather than showing its age", () => {
  assert.equal(
    cardNote(run({ column: "running", blocked: [{ task: "002", by: ["001"] }] })),
    "waiting",
  );
});

test("currentTask names the task an agent actually holds", () => {
  const card = run({
    agents: [{ id: "r/impl", role: "implementer", state: "working", task: "004" }],
  });
  assert.equal(currentTask(card), "T-004");
});

test("with no agent it falls back to the blocked task, else nothing", () => {
  assert.equal(currentTask(run({ blocked: [{ task: "007", by: ["003"] }] })), "T-007");
  assert.equal(currentTask(run()), null);
});

test("assignments fold by agent — one row per person, not one per task", () => {
  const card = run({
    assigned: [
      { task: "001", to: "implementer" },
      { task: "003", to: "implementer" },
      { task: "002", to: "verifier" },
    ],
  });
  assert.deepEqual(assignedByAgent(card), [
    { to: "implementer", tasks: ["001", "003"] },
    { to: "verifier", tasks: ["002"] },
  ]);
});

test("a card with no assignments folds to nothing", () => {
  assert.deepEqual(assignedByAgent(run()), []);
});

// Keyboard parity with drag (doc 19 a11y). Drag-and-drop is mouse-only, so these arrows ARE the board's
// write action for anyone not using a mouse — and they must obey exactly the same `canDrop` rules.
test("→ moves a backlog item to Ready, ← moves it back", () => {
  assert.equal(keyboardTarget(item({ column: "backlog" }), 1), "ready");
  assert.equal(keyboardTarget(item({ column: "ready" }), -1), "backlog");
});

test("an item never lands in a column it cannot be dropped into", () => {
  // → from Ready would be Running, which an item cannot enter — so there is nowhere to go, not a
  // silent slide into a column the drag rules forbid.
  assert.equal(keyboardTarget(item({ column: "ready" }), 1), null);
  assert.equal(keyboardTarget(item({ column: "backlog" }), -1), null);
});

test("a run reaches Ready — its one legal move — by walking left past the columns it cannot enter", () => {
  assert.equal(keyboardTarget(run({ column: "running" }), -1), "ready");
  assert.equal(keyboardTarget(run({ column: "done" }), -1), "ready");
  assert.equal(keyboardTarget(run({ column: "running" }), 1), null);
});

test("every keyboard target agrees with canDrop — one rule, two input devices", () => {
  for (const from of COLUMNS) {
    for (const card of [item({ column: from.key }), run({ column: from.key })]) {
      for (const dir of [-1, 1] as const) {
        const target = keyboardTarget(card, dir);
        if (target !== null)
          assert.ok(canDrop(card, target), `${card.origin} ${from.key} ${dir} → ${target}`);
      }
    }
  }
});

// The run view's tab strip. It printed raw doc ids, so the tabs read `spec`, `task-003`, `adr-ADR-001`
// — the keys the server routes on, not names anyone chose to read.
const doc = (id: string, label: string): RunDoc => ({ id, label, status: "done" });

test("spec and plan tabs read as their kind, not as their routing id", () => {
  assert.equal(docTabLabel(doc("spec", "spec")), "Spec");
  assert.equal(docTabLabel(doc("plan", "plan")), "Plan");
});

test("a task tab is its number and its title, with the number printed once", () => {
  assert.equal(
    docTabLabel(doc("task-001", "001 Data layer: cursor query")),
    "001 · Data layer: cursor query",
  );
});

test("an ADR tab is its key and its title — the key from the id, the title after the colon", () => {
  assert.equal(
    docTabLabel(doc("adr-ADR-001", "adr ADR-001: stateless over files")),
    "ADR-001 · stateless over files",
  );
});

test("a titleless ADR or task reads as the bare key rather than trailing a naked separator", () => {
  assert.equal(docTabLabel(doc("adr-ADR-002", "adr ADR-002:")), "ADR-002");
  assert.equal(docTabLabel(doc("task-004", "004 ")), "004");
});

test("an id we cannot abbreviate keeps the server's label, and the id only when there is none", () => {
  assert.equal(docTabLabel(doc("notes", "Scratch notes")), "Scratch notes");
  assert.equal(docTabLabel(doc("notes", "")), "notes");
});

// The server substitutes the KEY when frontmatter carries no `title:` — so a titleless ADR arrives as
// "adr ADR-002: ADR-002". Rendering that faithfully gives "ADR-002 · ADR-002", a separator whose only job
// is to repeat what it separates. Missing and empty are the same fact and must read the same way.
test("a document whose title is just its key again reads as the bare key", () => {
  assert.equal(
    docTabLabel({ id: "adr-ADR-002", label: "adr ADR-002: ADR-002", status: "done" }),
    "ADR-002",
  );
  assert.equal(docTabLabel({ id: "task-004", label: "004 004", status: "todo" }), "004");
});
