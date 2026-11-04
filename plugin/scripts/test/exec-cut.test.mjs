// Tests for `lane exec cut <id> --decision <D> [--keep <paths>] [--message <m>] [--apply]` (field 95) on
// temp git repos: a preview writes nothing; the kept paths land from the lane's tip as one gated commit
// (rolled back on a red gate, the lane left as it was), the other lanes' guards trip only on an overlap
// with their files, `cut` is written, the ledger closed, the worktree removed and the branch kept as
// `agentry/<id>.cut`; without --keep nothing lands. Builders are simulated by committing in the worktree.
// Run: node --test plugin/scripts/test/exec-cut.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitFile, git, gitEnv } from "./git-repo.mjs";
import { writeSpec } from "./spec-files.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = join(HERE, "..", "lane.mjs");
const BOARD = join(HERE, "..", "board.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};

const ON = { dispatched: "doing", built: "verify", failed: "doing", merged: "done", cut: "cut" };
const SPEC = {
  version: 1,
  name: "Cut",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" }, verdict: { column: "Verdict" } },
      status: {
        field: "status",
        values: {
          todo: "planned",
          doing: "active",
          verify: "active",
          done: "done",
          cut: "dropped",
        },
      },
      contract: { blocks: ["TASKS.md"] },
    },
    decision: {
      label: "Decision",
      at: { table: "DECISIONS.md", heading: "Decisions" },
      id: { column: "#", prefix: "D" },
      fields: { decision: { column: "Decision" } },
    },
  },
  rules: [{ rule: "ids-unique" }],
  lifecycle: { kind: "task", on: ON, write: { status: "status", verdict: "verdict" } },
  // Red whenever main holds boom.txt: a kept file can make the land's gate fail.
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "test ! -e boom.txt"] }] },
};
const BOARD_MD = `# Cut

## Tasks

| Task | Status | Verdict |
| ---- | ------ | ------- |
| T1   | todo   |         |
| T2   | todo   |         |
| T3   | todo   |         |
`;
const DECISIONS_MD = `# Decisions

## Decisions

| # | Decision |
| - | -------- |
| 7 | T1 is superseded by T4; keep its raws |
`;
const TASKS_MD = `# Tasks

### T1 · Raw art

- **Owns:** \`art/\`, \`notes.txt\`. Accept: the raws exist.

### T2 · Touches the raws

- **Owns:** \`art/raw/a.png\`. Accept: a.png exists.

### T3 · Elsewhere

- **Owns:** \`docs/three.md\`. Accept: three.md exists.
`;

function repo({ spec = SPEC } = {}) {
  const root = temp("cut-repo-");
  const home = temp("cut-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/DECISIONS.md", DECISIONS_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "art/old.png", "old\n");
  writeSpec(join(root, ".agentry"), spec);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  return { root, home };
}
const env = (r) => ({ ...gitEnv, HOME: r.home, NO_COLOR: "1" });
function run(r, script, args) {
  const res = spawnSync("node", [script, ...args, "--root", r.root], {
    encoding: "utf8",
    env: env(r),
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* a refusal on stderr */
  }
  return { exit: res.status, json, out: res.stdout + res.stderr };
}
const lane = (r, ...args) => run(r, LANE, ["exec", ...args, "--json"]);
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const boardText = (root) => readFileSync(join(root, "plan", "BOARD.md"), "utf8");
const statusOf = (root, id) => new RegExp(`\\| ${id} +\\| (\\S+)`).exec(boardText(root))[1];
const hasRef = (root, ref) =>
  spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", ref], { env: gitEnv })
    .status === 0;
// Everything a refusal or a preview must leave as it was.
const snapshot = (r, id = "T1") => ({
  head: git(r.root, "rev-parse", "HEAD"),
  status: git(r.root, "status", "--porcelain", "--untracked-files=all"),
  refs: git(r.root, "for-each-ref", "--format=%(refname) %(objectname)"),
  trees: git(r.root, "worktree", "list", "--porcelain"),
  ledger: readFileSync(ledgerFile(r.root, id), "utf8"),
  board: boardText(r.root),
});

// T1 started; its builder commits two raws, a deleted old file, a note and (for `boom`) boom.txt, leaves
// an uncommitted file, then the lane is parked: no agent out.
function parked(r, { boom = false } = {}) {
  const out = lane(r, "start", "T1").json;
  const w = out.worktree;
  commitFile(w, "art/raw/a.png", "a\n", "feat(art): a");
  commitFile(w, "art/raw/b.png", "b\n", "feat(art): b");
  git(w, "rm", "-q", "art/old.png");
  git(w, "commit", "-q", "-m", "chore(art): drop old");
  commitFile(w, "notes.txt", "not kept\n", "docs: notes");
  if (boom) commitFile(w, "boom.txt", "red\n", "test: boom");
  writeFileSync(join(w, "scratch.txt"), "half done\n");
  assert.equal(lane(r, "hold", "T1", "--for", "later", "--note", "superseded").exit, 0);
  return { worktree: w, tip: git(r.root, "rev-parse", "agentry/T1") };
}

test("a preview of cut --keep says what it would do and writes nothing", () => {
  const r = repo();
  parked(r);
  const before = snapshot(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw");
  assert.equal(res.exit, 0, res.out);
  assert.deepEqual(res.json.kept, ["art/raw/a.png", "art/raw/b.png"]);
  assert.match(res.json.land, /2 file\(s\).*"chore\(art\): keep 2 files from T1"/);
  assert.match(res.json.next, /exec cut T1 .*--decision D7 --keep art\/raw --apply$/);
  assert.match(res.json.preview, /nothing written/);
  assert.deepEqual(snapshot(r), before);
});

test("cut --keep --apply lands the kept files as one gated commit and retires the lane", () => {
  const r = repo();
  const { worktree, tip } = parked(r);
  const preHead = git(r.root, "rev-parse", "HEAD");
  const res = lane(
    r,
    "cut",
    "T1",
    "--decision",
    "d7",
    "--keep",
    "art/raw/a.png,art/old.png",
    "--apply",
  );
  assert.equal(res.exit, 0, res.out);
  // One commit on main: the kept files as the tip has them (old.png deleted), nothing else of the branch.
  assert.equal(git(r.root, "rev-parse", "HEAD^"), preHead);
  assert.equal(git(r.root, "log", "-1", "--format=%s"), "chore(art): keep 2 files from T1");
  assert.equal(
    git(r.root, "diff", "--name-status", preHead, "HEAD"),
    "D\tart/old.png\nA\tart/raw/a.png",
  );
  assert.equal(readFileSync(join(r.root, "art", "raw", "a.png"), "utf8"), "a\n");
  assert.equal(existsSync(join(r.root, "notes.txt")), false);
  // The ledger: closed, the cut recorded, no land record left for a guard or drift to read.
  const ledger = ledgerOf(r.root, "T1");
  assert.equal(ledger.state, "closed");
  assert.equal(ledger.merge, undefined);
  assert.deepEqual(
    { ...ledger.cut, at: typeof ledger.cut.at },
    {
      decision: "D7",
      kept: ["art/old.png", "art/raw/a.png"],
      commit: git(r.root, "rev-parse", "HEAD"),
      at: "string",
      uncommitted: join(
        r.root,
        ".agentry",
        "run",
        "process",
        "runs",
        "T1",
        "cut",
        "uncommitted.diff",
      ),
    },
  );
  assert.match(readFileSync(ledger.cut.uncommitted, "utf8"), /scratch\.txt/);
  assert.ok(
    ledger.gates.some((g) => g.where === "main" && g.exit === 0),
    "the merge tier ran",
  );
  // The board says cut; the worktree is gone; the branch is kept by its tip.
  assert.equal(statusOf(r.root, "T1"), "cut");
  assert.equal(existsSync(worktree), false);
  assert.equal(hasRef(r.root, "refs/heads/agentry/T1"), false);
  assert.equal(git(r.root, "rev-parse", "agentry/T1.cut"), tip);
});

test("cut --keep --message uses the owner's subject", () => {
  const r = repo();
  parked(r);
  const res = lane(
    r,
    "cut",
    "T1",
    "--decision",
    "D7",
    "--keep",
    "art",
    "--message",
    "feat(art): canon raws",
    "--apply",
  );
  assert.equal(res.exit, 0, res.out);
  assert.equal(git(r.root, "log", "-1", "--format=%s"), "feat(art): canon raws");
  assert.deepEqual(ledgerOf(r.root, "T1").cut.kept, [
    "art/old.png",
    "art/raw/a.png",
    "art/raw/b.png",
  ]);
});

test("cut without --keep lands nothing on main, writes cut and retires the lane", () => {
  const r = repo();
  const { worktree, tip } = parked(r);
  const head = git(r.root, "rev-parse", "HEAD");
  const res = lane(r, "cut", "T1", "--decision", "D7", "--apply");
  assert.equal(res.exit, 0, res.out);
  assert.equal(git(r.root, "rev-parse", "HEAD"), head);
  // Only the board's uncommitted cut word is on main.
  assert.equal(git(r.root, "status", "--porcelain"), "M plan/BOARD.md");
  assert.equal(statusOf(r.root, "T1"), "cut");
  const ledger = ledgerOf(r.root, "T1");
  assert.equal(ledger.state, "closed");
  assert.deepEqual([ledger.cut.decision, ledger.cut.kept, ledger.cut.commit], ["D7", [], null]);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(r.root, "rev-parse", "agentry/T1.cut"), tip);
});

test("a red gate on the kept commit rolls main back and leaves the lane as it was", () => {
  const r = repo();
  const { worktree, tip } = parked(r, { boom: true });
  const before = snapshot(r);
  const was = ledgerOf(r.root, "T1");
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw,boom.txt", "--apply");
  assert.equal(res.exit, 1, res.out);
  assert.match(
    res.out,
    /gate on the kept commit stopped it: main is back at .*T1 is as it was \(held\)/,
  );
  assert.equal(git(r.root, "rev-parse", "HEAD"), before.head);
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), before.status);
  assert.equal(boardText(r.root), before.board);
  const ledger = ledgerOf(r.root, "T1");
  assert.deepEqual([ledger.state, ledger.merge, ledger.cut], ["held", undefined, undefined]);
  assert.deepEqual(ledger.hold, was.hold);
  assert.ok(
    ledger.gates.some((g) => g.where === "main" && g.exit !== 0),
    "the red gate is recorded",
  );
  assert.ok(existsSync(join(worktree, "scratch.txt")));
  assert.equal(git(r.root, "rev-parse", "agentry/T1"), tip);
  assert.equal(hasRef(r.root, "refs/heads/agentry/T1.cut"), false);
});

// T2 owns a kept file, T3 does not: after the cut lands, only T2's report trips its guard.
test("the other lanes' guards trip on the kept commit only where it touches their files", () => {
  const r = repo();
  parked(r);
  const lanes = ["T2", "T3"].map((id) => ({ id, out: lane(r, "start", id).json }));
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 0, res.out);
  // Their dispatched writes were carried through the land and are back on main, uncommitted.
  assert.deepEqual(
    ["T1", "T2", "T3"].map((id) => statusOf(r.root, id)),
    ["cut", "doing", "doing"],
  );
  for (const { id, out } of lanes) {
    commitFile(
      out.worktree,
      id === "T2" ? "art/raw/a.png" : "docs/three.md",
      `${id}\n`,
      `feat: ${id}`,
    );
    writeFileSync(out.reportPath, "DONE\nbuilt it\n");
  }
  const t2 = lane(r, "report", "T2");
  assert.equal(ledgerOf(r.root, "T2").hold?.for, "guard", t2.out);
  assert.match(ledgerOf(r.root, "T2").hold.reason, /touches art\/raw\/a\.png, this lane's files/);
  const t3 = lane(r, "report", "T3");
  assert.equal(t3.exit, 0, t3.out);
  assert.equal(ledgerOf(r.root, "T3").hold, undefined, t3.out);
  assert.equal(ledgerOf(r.root, "T3").state, "verifying");
});

test("session start and the board never show a cut lane as held or idle", () => {
  const r = repo();
  parked(r);
  const held = JSON.parse(run(r, LANE, ["session", "start", "--json"]).out);
  assert.deepEqual(
    held.held.map((h) => h.id),
    ["T1"],
    "parked before the cut",
  );
  assert.equal(lane(r, "cut", "T1", "--decision", "D7", "--apply").exit, 0);
  const start = run(r, LANE, ["session", "start", "--json"]);
  const s = JSON.parse(start.out);
  assert.deepEqual(s.held, []);
  assert.deepEqual(s.idle, []);
  assert.deepEqual(s.ledgers, []);
  assert.equal(s.status.nudges.filter((n) => n.id === "T1").length, 0, start.out);
  const text = run(r, LANE, ["session", "start"]).out;
  assert.doesNotMatch(text, /T1/);
  const board = run(r, BOARD, ["status", "--json"]);
  assert.equal(board.exit, 0, board.out);
  assert.doesNotMatch(JSON.stringify(board.json.nudges ?? []), /T1/);
});

test("cut refuses an agent out on the lane, nothing written", () => {
  const r = repo();
  lane(r, "start", "T1");
  const before = snapshot(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--apply");
  assert.equal(res.exit, 2);
  assert.match(res.out, /a builder is out: hold it first/);
  assert.deepEqual(snapshot(r), before);
});

test("cut refuses a missing --decision and one the board does not hold, nothing written", () => {
  const r = repo();
  parked(r);
  const before = snapshot(r);
  const none = lane(r, "cut", "T1", "--apply");
  assert.equal(none.exit, 2);
  assert.match(none.out, /cut needs --decision <D>/);
  const unknown = lane(r, "cut", "T1", "--decision", "D8", "--apply");
  assert.equal(unknown.exit, 2);
  assert.match(unknown.out, /D8 is not a decision on the board/);
  assert.deepEqual(snapshot(r), before);
});

test("cut refuses a --keep path the branch does not change, nothing written", () => {
  const r = repo();
  parked(r);
  const before = snapshot(r);
  const res = lane(
    r,
    "cut",
    "T1",
    "--decision",
    "D7",
    "--keep",
    "art/raw,plan/BOARD.md",
    "--apply",
  );
  assert.equal(res.exit, 2);
  assert.match(res.out, /--keep: the branch does not change plan\/BOARD\.md/);
  assert.deepEqual(snapshot(r), before);
});

test("cut refuses a lane mid-land, nothing written", () => {
  const r = repo();
  parked(r);
  const ledger = ledgerOf(r.root, "T1");
  writeFileSync(
    ledgerFile(r.root, "T1"),
    `${JSON.stringify({ ...ledger, state: "merging", merge: { step: "gating" } }, null, 2)}\n`,
  );
  const before = snapshot(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 2);
  assert.match(res.out, /T1 is mid-land \(merge step gating\): finish the land first/);
  assert.deepEqual(snapshot(r), before);
});

test("cut refuses with the key to add when lifecycle.on.cut is unset, nothing written", () => {
  const { cut: _, ...on } = ON;
  const r = repo({ spec: { ...SPEC, lifecycle: { ...SPEC.lifecycle, on } } });
  parked(r);
  const before = snapshot(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--apply");
  assert.equal(res.exit, 2);
  assert.match(res.out, /the workflow file has no lifecycle\.on\.cut: add it/);
  assert.deepEqual(snapshot(r), before);
});
