// Tests for `lane exec cut <id> --decision <D> [--keep <paths>] [--message <m>] [--apply]` (field 95) on
// temp git repos: a preview writes nothing; the kept paths land from the lane's tip as one gated commit
// (rolled back on a red gate, the lane left as it was), the other lanes' guards trip only on an overlap
// with their files, `cut` is written, the ledger closed, the worktree removed and the branch kept as
// `agentry/<id>.cut`; without --keep nothing lands. Builders are simulated by committing in the worktree.
// Run: node --test plugin/scripts/test/exec-cut.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  packed: existsSync(join(r.root, ".git", "packed-refs"))
    ? readFileSync(join(r.root, ".git", "packed-refs"), "utf8")
    : "",
  cutDir: existsSync(join(runsDir(r.root), id, "cut")),
});
const runsDir = (root) => join(root, ".agentry", "run", "process", "runs");
const { lifecycle: _life, ...NO_LIFECYCLE } = SPEC;

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
  // One kept commit on main: the kept files as the tip has them (old.png deleted), nothing else of the
  // branch; then the board commit of the cut word, and main is clean.
  assert.equal(git(r.root, "rev-parse", "HEAD~2"), preHead);
  assert.equal(
    git(r.root, "log", "-1", "--format=%s", "HEAD^"),
    "chore(art): keep 2 files from T1",
  );
  assert.equal(
    git(r.root, "diff", "--name-status", preHead, "HEAD^"),
    "D\tart/old.png\nA\tart/raw/a.png",
  );
  assert.equal(git(r.root, "log", "-1", "--format=%s"), "chore(board): cut T1 (D7)");
  assert.equal(git(r.root, "diff", "--name-only", "HEAD^", "HEAD"), "plan/BOARD.md");
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "");
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
      commit: git(r.root, "rev-parse", "HEAD^"),
      boardCommit: git(r.root, "rev-parse", "HEAD"),
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
  assert.equal(git(r.root, "log", "-1", "--format=%s", "HEAD^"), "feat(art): canon raws");
  assert.equal(git(r.root, "log", "-1", "--format=%s"), "chore(board): cut T1 (D7)");
  assert.deepEqual(ledgerOf(r.root, "T1").cut.kept, [
    "art/old.png",
    "art/raw/a.png",
    "art/raw/b.png",
  ]);
});

test("cut without --keep lands none of the branch on main: only the board commit of cut", () => {
  const r = repo();
  const { worktree, tip } = parked(r);
  const head = git(r.root, "rev-parse", "HEAD");
  const res = lane(r, "cut", "T1", "--decision", "D7", "--apply");
  assert.equal(res.exit, 0, res.out);
  assert.equal(git(r.root, "rev-parse", "HEAD^"), head);
  assert.equal(git(r.root, "log", "-1", "--format=%s"), "chore(board): cut T1 (D7)");
  assert.equal(git(r.root, "diff", "--name-only", head, "HEAD"), "plan/BOARD.md");
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(statusOf(r.root, "T1"), "cut");
  const ledger = ledgerOf(r.root, "T1");
  assert.equal(ledger.state, "closed");
  assert.deepEqual(
    [ledger.cut.decision, ledger.cut.kept, ledger.cut.commit, ledger.cut.boardCommit],
    ["D7", [], null, git(r.root, "rev-parse", "HEAD")],
  );
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

// T3 builds beside T1; once T1 is cut (its board commit holds T3's carried dispatched write too), main
// is clean and T3's land preflights and lands as any land does.
test("after a cut, another lane's lane merge preflights and lands normally", () => {
  const r = repo();
  parked(r);
  const t3 = lane(r, "start", "T3").json;
  assert.equal(lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply").exit, 0);
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "");
  commitFile(t3.worktree, "docs/three.md", "three\n", "docs: three");
  writeFileSync(t3.reportPath, "DONE\nbuilt it\nused_memories: none\n");
  const verify = lane(r, "report", "T3");
  assert.equal(verify.json?.next, "verify", verify.out);
  writeFileSync(verify.json.reportPath, "All checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", "T3").json.next, "gate");
  assert.equal(lane(r, "gate", "T3").json.next, "close");
  assert.equal(lane(r, "close", "T3").json.next, "merge");
  const pre = run(r, LANE, ["merge", "T3", "--preflight"]);
  assert.equal(pre.exit, 0, pre.out);
  const land = run(r, LANE, ["merge", "T3", "--message", "chore(board): land T3"]);
  assert.equal(land.exit, 0, land.out);
  assert.equal(git(r.root, "log", "-1", "--format=%s"), "chore(board): land T3");
  assert.equal(readFileSync(join(r.root, "docs", "three.md"), "utf8"), "three\n");
  assert.deepEqual(
    ["T1", "T3"].map((id) => statusOf(r.root, id)),
    ["cut", "done"],
  );
  // Nothing but the episode T3's close wrote to the repo's memory store.
  assert.match(
    git(r.root, "status", "--porcelain", "--untracked-files=all"),
    /^\?\? \.agentry\/memory\/episodes\/t3-built-it-[0-9A-Z]{26}\.md$/,
  );
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
  // Its episode waits to be written, as any finished lane's does; once closed nothing names it.
  assert.deepEqual(
    s.status.nudges.filter((n) => n.id === "T1").map((n) => n.kind),
    ["episode-pending"],
    start.out,
  );
  assert.equal(lane(r, "close", "T1").exit, 0);
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

test("cut refuses while another lane is mid-land, nothing written", () => {
  const r = repo();
  parked(r);
  lane(r, "start", "T3");
  const l3 = ledgerOf(r.root, "T3");
  writeFileSync(
    ledgerFile(r.root, "T3"),
    `${JSON.stringify({ ...l3, state: "merging", merge: { step: "gating" } }, null, 2)}\n`,
  );
  const before = snapshot(r);
  for (const args of [["--apply"], ["--keep", "art/raw", "--apply"], []]) {
    const res = lane(r, "cut", "T1", "--decision", "D7", ...args);
    assert.equal(res.exit, 2, res.out);
    assert.match(res.out, /main is mid-land \(T3\)/);
  }
  assert.deepEqual(snapshot(r), before);
});

test("with the lifecycle off, a cut without --keep makes no commit and still retires the lane", () => {
  const r = repo({ spec: NO_LIFECYCLE });
  const { tip, worktree } = parked(r);
  const head = git(r.root, "rev-parse", "HEAD");
  const board = boardText(r.root);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--apply");
  assert.equal(res.exit, 0, res.out);
  assert.equal(git(r.root, "rev-parse", "HEAD"), head);
  assert.equal(boardText(r.root), board);
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "");
  const l = ledgerOf(r.root, "T1");
  assert.deepEqual([l.state, l.cut.commit, l.cut.boardCommit], ["closed", null, null]);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(r.root, "rev-parse", "agentry/T1.cut"), tip);
});

test("with the lifecycle off, a cut --keep lands only the kept commit, no board commit", () => {
  const r = repo({ spec: NO_LIFECYCLE });
  parked(r);
  const head = git(r.root, "rev-parse", "HEAD");
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 0, res.out);
  assert.equal(git(r.root, "rev-parse", "HEAD^"), head);
  assert.equal(git(r.root, "log", "-1", "--format=%s"), "chore(art): keep 2 files from T1");
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(ledgerOf(r.root, "T1").cut.boardCommit, null);
});

test("a case twin of the lane branch (packed agentry/t1 beside agentry/T1) refuses, nothing written", () => {
  const r = repo();
  git(r.root, "checkout", "-q", "-b", "agentry/t1");
  commitFile(r.root, "decoy.txt", "decoy\n", "feat: decoy");
  git(r.root, "checkout", "-q", "main");
  git(r.root, "pack-refs", "--all");
  parked(r);
  const before = snapshot(r);
  for (const args of [[], ["--apply"], ["--keep", "art/raw", "--apply"]]) {
    const res = lane(r, "cut", "T1", "--decision", "D7", ...args);
    assert.equal(res.exit, 2, res.out);
    assert.match(res.out, /case twin/);
  }
  assert.deepEqual(snapshot(r), before);
});

test("a case twin of the kept name (a packed agentry/T1.CUT) refuses, nothing written", () => {
  const r = repo();
  const { tip } = parked(r);
  git(r.root, "pack-refs", "--all");
  const packed = join(r.root, ".git", "packed-refs");
  writeFileSync(packed, `${readFileSync(packed, "utf8")}${tip} refs/heads/agentry/T1.CUT\n`);
  const before = snapshot(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--apply");
  assert.equal(res.exit, 2, res.out);
  assert.match(res.out, /agentry\/T1\.cut exists/);
  assert.deepEqual(snapshot(r), before);
});

// A repo whose gate runs `script` on main mid-land: after the plan's checks, before the branch is kept.
const gateRuns = (script) =>
  repo({ spec: { ...SPEC, gate: { tiers: [{ name: "full", command: ["sh", "-c", script] }] } } });
const agentryRefs = (r) =>
  git(r.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/agentry/");

test("a case twin of the kept name made during the land stops the branch rename, the lane branch kept", () => {
  // The gate packs a ref agentry/T1.CUT after the plan's check: the rename looks again right before it.
  const r = gateRuns("git update-ref refs/heads/agentry/T1.CUT HEAD && git pack-refs --all");
  const { tip } = parked(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 1, res.out);
  assert.match(
    res.out,
    /branch was not kept as agentry\/T1\.cut: agentry\/T1\.CUT would be a case twin of agentry\/T1\.cut/,
  );
  // Nothing made: both steps are still owed, after the fix.
  assert.ok(
    res.out.includes(
      `rename it first → fix that, then: git update-ref refs/heads/agentry/T1.cut ${tip} ''; git update-ref -d refs/heads/agentry/T1 ${tip}`,
    ),
    res.out,
  );
  assert.equal(git(r.root, "rev-parse", "refs/heads/agentry/T1"), tip);
  assert.ok(!git(r.root, "for-each-ref", "--format=%(refname)").includes("agentry/T1.cut"));
});

test("a case twin of the lane branch made during the land stops the rename: neither branch is deleted", () => {
  // A packed agentry/t1 at the same commit would pass the delete's old-value check and go with it.
  const r = gateRuns(
    "git pack-refs --all && git update-ref refs/heads/agentry/t1 refs/heads/agentry/T1 && git pack-refs --all",
  );
  const { tip } = parked(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 1, res.out);
  assert.match(res.out, /agentry\/T1 has a case twin agentry\/t1/);
  // The kept branch is made: only the lane branch's delete is owed, after the fix.
  assert.ok(
    res.out.includes(`agentry/T1.cut holds ${tip.slice(0, 7)} and agentry/T1 was not deleted: `),
    res.out,
  );
  assert.ok(
    res.out.includes(`→ fix that, then: git update-ref -d refs/heads/agentry/T1 ${tip}`),
    res.out,
  );
  assert.doesNotMatch(res.out, /update-ref refs\/heads\/agentry\/T1\.cut/);
  const refs = agentryRefs(r);
  assert.ok(refs.includes(`refs/heads/agentry/T1 ${tip}`), refs);
  assert.ok(refs.includes(`refs/heads/agentry/t1 ${tip}`), refs);
});

test("the lane branch moved during the land stops the rename: the moved branch is kept", () => {
  const r = gateRuns("git update-ref refs/heads/agentry/T1 HEAD");
  const { tip } = parked(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 1, res.out);
  assert.match(res.out, new RegExp(`agentry/T1 moved off ${tip} meanwhile`));
  // No step: the owner checks the moved branch.
  assert.ok(
    res.out.includes(
      `agentry/T1.cut holds ${tip.slice(0, 7)}, the old tip, and agentry/T1 moved off ${tip} meanwhile: agentry/T1 was left as it is; check it, then delete it by hand`,
    ),
    res.out,
  );
  assert.doesNotMatch(res.out, /update-ref|exec cut T1 --/);
  const refs = agentryRefs(r);
  assert.notEqual(git(r.root, "rev-parse", "refs/heads/agentry/T1"), tip, "the moved branch went");
  assert.ok(refs.includes(`refs/heads/agentry/T1.cut ${tip}`), refs);
});

test("the lane's owner calls survive the cut and stay open in session close until recorded", () => {
  const r = repo();
  parked(r);
  assert.equal(run(r, LANE, ["note", "T1", "--owner", "keep the raws, drop the rest"]).exit, 0);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 0, res.out);
  assert.equal(ledgerOf(r.root, "T1").calls?.length, 1);
  const open = JSON.parse(run(r, LANE, ["session", "close"]).out).calls;
  assert.ok(
    open.some((c) => c.id === "T1" && /keep the raws/.test(c.open[0].text)),
    JSON.stringify(open),
  );
  const mark = run(r, LANE, ["note", "T1", "--recorded", "all", "--where", "DECISIONS.md D7"]);
  assert.equal(mark.exit, 0, mark.out);
  const after = JSON.parse(run(r, LANE, ["session", "close"]).out).calls;
  assert.ok(!after.some((c) => c.id === "T1"), JSON.stringify(after));
});

test("the lane's owner calls survive a red-gate rollback too", () => {
  const r = repo();
  parked(r, { boom: true });
  run(r, LANE, ["note", "T1", "--owner", "keep boom"]);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "boom.txt", "--apply");
  assert.equal(res.exit, 1, res.out);
  assert.equal(ledgerOf(r.root, "T1").calls?.length, 1);
});

test("a red gate with another lane's carried write leaves main, the board and both ledgers as they were", () => {
  const r = repo();
  const { worktree, tip } = parked(r, { boom: true });
  lane(r, "start", "T3");
  const before = snapshot(r);
  const t3 = readFileSync(ledgerFile(r.root, "T3"), "utf8");
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "boom.txt", "--apply");
  assert.equal(res.exit, 1, res.out);
  assert.equal(git(r.root, "rev-parse", "HEAD"), before.head);
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), before.status);
  assert.equal(boardText(r.root), before.board);
  assert.equal(statusOf(r.root, "T3"), "doing");
  assert.equal(readFileSync(ledgerFile(r.root, "T3"), "utf8"), t3);
  assert.equal(ledgerOf(r.root, "T1").state, "held");
  assert.equal(git(r.root, "rev-parse", "agentry/T1"), tip);
  assert.ok(existsSync(join(worktree, "scratch.txt")));
  assert.equal(existsSync(join(runsDir(r.root), "T1", "cut", "uncommitted.diff")), false);
  const again = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(again.exit, 0, again.out);
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "");
});

test("a commit-msg hook refusing the board commit takes the kept commit off main, the lane as it was", () => {
  const r = repo();
  const { tip, worktree } = parked(r);
  const hooks = join(r.root, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, "commit-msg"),
    '#!/bin/sh\ngrep -q "chore(board): cut" "$1" && { echo "no board cuts" >&2; exit 1; }\nexit 0\n',
  );
  chmodSync(join(hooks, "commit-msg"), 0o755);
  const before = snapshot(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 1, res.out);
  assert.match(res.out, /board commit refused/);
  assert.equal(git(r.root, "rev-parse", "HEAD"), before.head);
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), before.status);
  assert.equal(boardText(r.root), before.board);
  const l = ledgerOf(r.root, "T1");
  assert.deepEqual([l.state, l.merge, l.cut], ["held", undefined, undefined]);
  assert.equal(git(r.root, "rev-parse", "agentry/T1"), tip);
  assert.ok(existsSync(worktree));
  assert.equal(existsSync(join(runsDir(r.root), "T1", "cut", "uncommitted.diff")), false);
});

test("a cut's episode is in its closed ledger, written and stamped by exec close, and then not pending", () => {
  const r = repo();
  parked(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(res.exit, 0, res.out);
  assert.match(
    res.json.episode.outcome,
    /^cut on D7: kept 2 file\(s\) \(art\/raw\/a\.png, art\/raw\/b\.png\) in [0-9a-f]{7}/,
  );
  assert.match(
    res.json.afterwards,
    /^\S.*exec close T1 --root \S+ writes this episode to the memory store and stamps it$/,
  );
  assert.deepEqual(ledgerOf(r.root, "T1").episode.payload, res.json.episode);
  assert.ok(JSON.parse(run(r, LANE, ["session", "close"]).out).episodesPending.includes("T1"));
  const closed = lane(r, "close", "T1");
  assert.equal(closed.exit, 0, closed.out);
  assert.equal(closed.json.episode.outcome, res.json.episode.outcome);
  const { writtenId } = ledgerOf(r.root, "T1").episode;
  assert.match(writtenId, /^p:[0-9A-Z]{26}$/);
  const episodes = readdirSync(join(r.root, ".agentry", "memory", "episodes"));
  assert.deepEqual(episodes.filter((f) => f.endsWith(`-${writtenId.slice(2)}.md`)).length, 1);
  assert.ok(!JSON.parse(run(r, LANE, ["session", "close"]).out).episodesPending.includes("T1"));
});

// The gate kills the cut that runs it (the host's limit hitting a long gate): the cut is left mid-land.
// A rerun rolls its own stuck state back, and the one after cuts.
test("a cut killed mid-gate is rolled back by the next exec cut --apply, and the one after cuts", () => {
  const dir = temp("cut-killer-");
  const killer = join(dir, "killer.sh");
  writeFileSync(
    killer,
    `#!/bin/sh
test -e boom.txt || exit 0
for p in $(ps -axo pid=,command= | grep "exec cut T1" | grep -F -- "$PWD" | grep -v grep | awk '{print $1}'); do kill -9 "$p"; done
sleep 1
exit 1
`,
  );
  const r = repo({
    spec: { ...SPEC, gate: { tiers: [{ name: "full", command: ["sh", killer] }] } },
  });
  const { tip } = parked(r, { boom: true });
  const preHead = git(r.root, "rev-parse", "HEAD");
  lane(r, "cut", "T1", "--decision", "D7", "--keep", "boom.txt", "--apply");
  const stuck = ledgerOf(r.root, "T1");
  assert.deepEqual([stuck.state, stuck.merge?.cut], ["merging", true], "the kill left it mid-land");
  // A preview names the cut itself as the way out, never lane merge --resolve.
  const preview = lane(r, "cut", "T1", "--decision", "D7", "--keep", "boom.txt");
  assert.equal(preview.exit, 2, preview.out);
  assert.match(preview.out, /exec cut T1 --decision <D> --apply rolls it back/);
  assert.doesNotMatch(preview.out, /--resolve/);
  const back = lane(r, "cut", "T1", "--decision", "D7", "--keep", "boom.txt", "--apply");
  assert.equal(back.exit, 1, back.out);
  assert.match(back.out, /rolled back the stuck cut: .*T1 is held again → run exec cut again/);
  assert.doesNotMatch(back.out, /--resolve/);
  assert.equal(git(r.root, "rev-parse", "HEAD"), preHead);
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "M plan/BOARD.md");
  assert.equal(statusOf(r.root, "T1"), "doing", "the lane's carried dispatched write is back");
  const l = ledgerOf(r.root, "T1");
  assert.deepEqual([l.state, l.merge, l.next], ["held", undefined, stuck.next]);
  assert.equal(git(r.root, "rev-parse", "agentry/T1"), tip);
  const cut = lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply");
  assert.equal(cut.exit, 0, cut.out);
  assert.equal(ledgerOf(r.root, "T1").state, "closed");
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "");
});

test("a stuck cut is not rolled back over a commit on main that is not its own", () => {
  const r = repo();
  parked(r);
  const l = ledgerOf(r.root, "T1");
  const preHead = git(r.root, "rev-parse", "HEAD");
  const other = commitFile(r.root, "docs/other.md", "x\n", "docs: someone else");
  writeFileSync(
    ledgerFile(r.root, "T1"),
    `${JSON.stringify({ ...l, state: "merging", merge: { cut: true, preHead, planned: [], landed: [], stateBefore: "held", step: "gated" } }, null, 2)}\n`,
  );
  const before = snapshot(r);
  const res = lane(r, "cut", "T1", "--decision", "D7", "--apply");
  assert.equal(res.exit, 2, res.out);
  assert.match(res.out, new RegExp(`${other.slice(0, 7)} docs: someone else`));
  assert.doesNotMatch(res.out, /--resolve/);
  assert.deepEqual(snapshot(r), before);
});

// ---- kills at every point of a cut, and the rerun that rolls it back --------------------------------
//
// A `node --import` preload SIGKILLs the cut right before or after the n-th spawnSync whose command line
// matches a pattern (CUT_KILL="before|<regex>|<n>" or "after|…"), so each kill point is exact.
const KILL_AT = `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spec = process.env.CUT_KILL;
if (spec) {
  const [when, pattern, nth = "1"] = spec.split("|");
  const re = new RegExp(pattern);
  let seen = 0;
  const orig = cp.spawnSync;
  const die = () => {
    process.kill(process.pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  };
  cp.spawnSync = function (cmd, args, opts) {
    const line = [cmd, ...(Array.isArray(args) ? args : [])].join(" ");
    const hit = re.test(line) && ++seen === Number(nth);
    if (hit && when === "before") die();
    const res = orig.apply(this, arguments);
    if (hit && when === "after") die();
    return res;
  };
  syncBuiltinESMExports();
}
`;
let killAt = null;
const killAtFile = () => {
  if (!killAt) {
    killAt = join(temp("cut-kill-at-"), "kill-at.mjs");
    writeFileSync(killAt, KILL_AT);
  }
  return killAt;
};
function runKilled(r, args, kill) {
  const res = spawnSync("node", ["--import", killAtFile(), LANE, ...args, "--root", r.root], {
    encoding: "utf8",
    env: { ...env(r), ...(kill && { CUT_KILL: kill }) },
  });
  return { exit: res.status, signal: res.signal, out: res.stdout + res.stderr };
}
const CUT_ARGS = [
  "exec",
  "cut",
  "T1",
  "--decision",
  "D7",
  "--keep",
  "art/raw",
  "--apply",
  "--json",
];
const cutT1 = (r, kill = null) => runKilled(r, CUT_ARGS, kill);
// The lane and main as a rollback must leave them.
const laneState = (r) => {
  const l = ledgerOf(r.root, "T1");
  return {
    head: git(r.root, "rev-parse", "HEAD"),
    status: git(r.root, "status", "--porcelain", "--untracked-files=all"),
    board: boardText(r.root),
    state: l.state,
    next: l.next,
    merge: l.merge ?? null,
    cut: l.cut ?? null,
    branch: git(r.root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/agentry/"),
  };
};

// A cut keeps its stuck state in the land's `merging` record (`merge.cut`): `lane merge` must refuse it in
// every mode (and with `--json`, or a `--branch` that would adopt the lane), naming the cut as the way out,
// with main and the ledger as they were.
const STOPPED_CUT = /T1 is a stopped cut: exec cut T1 --decision <D> --apply rolls it back/;
const MERGE_MODES = [
  ["--preflight"],
  ["--message", "chore(board): land T1"],
  ["--resolve", "landed"],
  ["--resolve", "rolled-back"],
  ["--check", "owner-ok=pass"],
  ["--push", "--approved"],
  ["--cleanup"],
  ["--preflight", "--json"],
  ["--preflight", "--branch", "agentry/T1"],
  ["--message", "chore(board): land T1", "--json"],
  ["--message", "chore(board): land T1", "--branch", "agentry/T1", "--drop-carry"],
];
function mergeRefusesCut(r, label) {
  const before = snapshot(r);
  for (const args of MERGE_MODES) {
    const res = run(r, LANE, ["merge", "T1", ...args]);
    const call = `${label}, merge ${args.join(" ")}`;
    assert.equal(res.exit, 2, `${call}: ${res.out}`);
    assert.match(res.out, STOPPED_CUT, call);
    assert.deepEqual(snapshot(r), before, `${call} changed something`);
  }
}
// A gate checklist item, so `--check` reaches the ledger.
const CHECKLIST = [{ name: "owner-ok", text: "the owner looked" }];

// T1 parked and T3 building beside it (its dispatched write carried by T1's cut).
function setup({ gate, checklist } = {}) {
  const tiers = gate ? [{ name: "full", command: gate }] : SPEC.gate.tiers;
  const r = repo({ spec: { ...SPEC, gate: { tiers, ...(checklist && { checklist }) } } });
  const p = parked(r);
  assert.equal(lane(r, "start", "T3").exit, 0);
  return { r, ...p, before: laneState(r) };
}
// The rerun after a kill: a rollback to the lane exactly as it was, a refusal, or a cut done outright.
function rerunMeetsBar(r, before, worktree, label) {
  const again = cutT1(r);
  const l = ledgerOf(r.root, "T1");
  assert.notEqual(l.state, "verified", `${label}: ${again.out}`);
  assert.doesNotMatch(again.out, /--resolve/, label);
  if (again.exit === 1 && /rolled back the stuck cut/.test(again.out)) {
    assert.deepEqual(laneState(r), before, `${label}: not the lane as it was: ${again.out}`);
    assert.ok(existsSync(join(worktree, "scratch.txt")), `${label}: worktree work gone`);
    return { again, kind: "rolled-back" };
  }
  return { again, kind: again.exit === 2 ? "refused" : `exit ${again.exit}` };
}
function finishes(r, label) {
  const res = cutT1(r);
  assert.equal(res.exit, 0, `${label}: the cut after the rollback: ${res.out}`);
  assert.equal(ledgerOf(r.root, "T1").state, "closed");
  assert.deepEqual(
    ["T1", "T3"].map((id) => statusOf(r.root, id)),
    ["cut", "doing"],
    label,
  );
  assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), "", label);
}

const KILL_POINTS = [
  [
    "K1 mid set-aside of the carry",
    "before|restore --source=HEAD --staged --worktree -- plan/BOARD.md|1",
  ],
  ["K2 before the kept pick", "before| cherry-pick |1"],
  ["K3 after the kept pick, before the ledger records it", "after| cherry-pick |1"],
  ["K4 before the gate starts", "before|supervise.mjs|1"],
  ["K5a board written, before git add", "before|add -- plan/BOARD.md|1"],
  ["K5b board staged, before the board commit", "before|commit --quiet -m chore\\(board\\)|1"],
  [
    "K6 after the board commit, before the ledger marks it",
    "after|commit --quiet -m chore\\(board\\)|1",
  ],
];
for (const [label, kill] of KILL_POINTS)
  test(`a cut killed at ${label}: lane merge refuses it, the rerun rolls back or cuts, then a cut finishes`, () => {
    const { r, before, worktree } = setup({ checklist: CHECKLIST });
    assert.equal(cutT1(r, kill).signal, "SIGKILL", label);
    const stuck = ledgerOf(r.root, "T1").merge?.cut;
    if (stuck) mergeRefusesCut(r, label);
    const { again, kind } = rerunMeetsBar(r, before, worktree, label);
    if (stuck) assert.equal(kind, "rolled-back", `${label}: ${again.out}`);
    if (kind === "rolled-back") finishes(r, label);
    else {
      assert.equal(again.exit, 0, `${label}: neither rolled back nor cut: ${again.out}`);
      assert.equal(ledgerOf(r.root, "T1").state, "closed");
      assert.equal(statusOf(r.root, "T3"), "doing", `${label}: T3's carried write lost`);
    }
  });

// A cut with no kept files: no pick and no gate, so a stuck one sits at `gated` with no `merge.gate`.
const NO_KEEP = CUT_ARGS.filter((a) => a !== "--keep" && a !== "art/raw");
for (const [label, kill] of [
  ["N-K1 mid set-aside of the carry", KILL_POINTS[0][1]],
  ["N-K5a board written, before git add", "before|add -- plan/BOARD.md|1"],
  ["N-K5b board staged, before the board commit", "before|commit --quiet -m chore\\(board\\)|1"],
])
  test(`a cut with no kept files killed at ${label}: lane merge refuses it, the rerun rolls back`, () => {
    const { r, before, worktree } = setup({ checklist: CHECKLIST });
    assert.equal(runKilled(r, NO_KEEP, kill).signal, "SIGKILL", label);
    const l = ledgerOf(r.root, "T1");
    if (!l.merge?.cut) {
      // Killed before the cut marked the ledger: nothing is stuck, and the rerun cuts.
      assert.equal(runKilled(r, NO_KEEP, null).exit, 0, label);
      return;
    }
    assert.deepEqual([l.merge.step, l.merge.gate], ["gated", undefined], label);
    mergeRefusesCut(r, label);
    const again = runKilled(r, NO_KEEP, null);
    assert.match(again.out, /rolled back the stuck cut/, `${label}: ${again.out}`);
    assert.deepEqual(laneState(r), before, label);
    assert.ok(existsSync(join(worktree, "scratch.txt")), label);
  });

test("a cut killed mid-gate, its gate running on: lane merge refuses it, the rerun stops the gate and rolls back", () => {
  const killer = join(temp("cut-gate-killer-"), "gate-killer.sh");
  writeFileSync(
    killer,
    `#!/bin/sh
test -e "$HOME/killed-once" && exit 0
touch "$HOME/killed-once"
for p in $(ps -axo pid=,command= | grep "exec cut T1 --decision D7 --keep art/raw --apply --json --root $PWD" | grep -v grep | awk '{print $1}'); do kill -9 "$p"; done
sleep 6
touch "$HOME/gate-finished"
exit 0
`,
  );
  const { r, before, worktree } = setup({ gate: ["sh", killer], checklist: CHECKLIST });
  assert.equal(cutT1(r).signal, "SIGKILL");
  assert.equal(ledgerOf(r.root, "T1").merge?.step, "gating");
  mergeRefusesCut(r, "mid-gate");
  const { again, kind } = rerunMeetsBar(r, before, worktree, "mid-gate");
  assert.equal(kind, "rolled-back", again.out);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 7000);
  assert.ok(!existsSync(join(r.home, "gate-finished")), "the stray gate ran on to the end");
  finishes(r, "mid-gate");
});

test("a cut killed after its board commit was marked refuses to roll back, nothing reset", () => {
  const { r } = setup();
  assert.equal(cutT1(r, "after|commit --quiet -m chore\\(board\\)|1").signal, "SIGKILL");
  const l = ledgerOf(r.root, "T1");
  const head = git(r.root, "rev-parse", "HEAD");
  const { carry: _c, writes: _w, ...merge } = l.merge;
  writeFileSync(
    ledgerFile(r.root, "T1"),
    `${JSON.stringify({ ...l, merge: { ...merge, cutBoard: head } }, null, 2)}\n`,
  );
  const again = cutT1(r);
  assert.equal(again.exit, 2, again.out);
  assert.match(again.out, /board commit .* holds the writes it set aside/);
  assert.equal(git(r.root, "rev-parse", "HEAD"), head);
});

test("a cut killed before its branch is kept leaves the branch at its tip; the rerun refuses", () => {
  const { r, tip } = setup();
  assert.equal(cutT1(r, "before|update-ref refs/heads/agentry/T1.cut|1").signal, "SIGKILL");
  assert.equal(cutT1(r).exit, 2);
  assert.equal(git(r.root, "rev-parse", "refs/heads/agentry/T1"), tip);
});

for (const [label, kill] of [
  ["before the pick", "before| cherry-pick |1"],
  ["after the pick", "after| cherry-pick |1"],
  ["after the board commit", "after|commit --quiet -m chore\\(board\\)|1"],
])
  test(`a stuck cut (killed ${label}) is never rolled back over someone else's commit`, () => {
    const { r } = setup();
    assert.equal(cutT1(r, kill).signal, "SIGKILL");
    commitFile(r.root, "docs/other.md", "someone else\n", "docs: someone else's commit");
    const head = git(r.root, "rev-parse", "HEAD");
    const status = git(r.root, "status", "--porcelain", "--untracked-files=all");
    const again = cutT1(r);
    assert.equal(again.exit, 2, again.out);
    assert.match(again.out, /not the stuck cut's: [0-9a-f]{7} docs: someone else's commit/);
    assert.equal(git(r.root, "rev-parse", "HEAD"), head);
    assert.equal(git(r.root, "status", "--porcelain", "--untracked-files=all"), status);
    assert.equal(ledgerOf(r.root, "T1").state, "merging");
  });

test("a foreign commit with the board commit's subject is not the cut's: the rerun refuses, it stays", () => {
  const { r } = setup();
  assert.equal(cutT1(r, "after| cherry-pick |1").signal, "SIGKILL");
  const foreign = commitFile(
    r.root,
    "docs/other.md",
    "someone else\n",
    "chore(board): cut T1 (D7)",
  );
  const again = cutT1(r);
  assert.equal(again.exit, 2, again.out);
  assert.match(again.out, /not the stuck cut's/);
  assert.equal(git(r.root, "rev-parse", "HEAD"), foreign);
  assert.ok(existsSync(join(r.root, "docs", "other.md")));
});

// Board writes others make while a cut is stuck: the rollback refuses rather than wipe them.
const STRANGE =
  /plan\/BOARD\.md has writes made after the cut stopped: commit or set them aside, then run exec cut again/;
test("an owner's hand edit of the board after a kill: the rerun refuses and the edit stays", () => {
  const { r } = setup();
  assert.equal(cutT1(r, "after| cherry-pick |1").signal, "SIGKILL");
  writeFileSync(join(r.root, "plan", "BOARD.md"), `${boardText(r.root)}\nowner note by hand\n`);
  const again = cutT1(r);
  assert.equal(again.exit, 2, again.out);
  assert.match(again.out, STRANGE);
  assert.ok(boardText(r.root).includes("owner note by hand"));
  assert.equal(ledgerOf(r.root, "T1").state, "merging");
});

test("the owner's board set while a cut is stuck: the rerun refuses and the write stays", () => {
  const { r } = setup();
  assert.equal(cutT1(r, "after| cherry-pick |1").signal, "SIGKILL");
  const set = run(r, BOARD, ["set", "task", "T2", "status=done", "--apply"]);
  assert.equal(set.exit, 0, set.out);
  const again = cutT1(r);
  assert.equal(again.exit, 2, again.out);
  assert.match(again.out, STRANGE);
  assert.equal(statusOf(r.root, "T2"), "done");
});

test("another lane's exec write while a cut is stuck (T3 reports built): the rerun refuses, it stays", () => {
  const { r } = setup();
  const t3 = ledgerOf(r.root, "T3");
  commitFile(t3.worktree, "docs/three.md", "three\n", "docs: three");
  assert.equal(cutT1(r, "after| cherry-pick |1").signal, "SIGKILL");
  writeFileSync(
    join(runsDir(r.root), "T3", "r1-build.report.md"),
    "DONE\nbuilt it\nused_memories: none\n",
  );
  const rep = lane(r, "report", "T3");
  assert.equal(rep.exit, 0, rep.out);
  const written = statusOf(r.root, "T3");
  assert.equal(written, "verify");
  const again = cutT1(r);
  assert.equal(again.exit, 2, again.out);
  assert.match(again.out, STRANGE);
  assert.equal(statusOf(r.root, "T3"), written);
});

test("a rollback killed after its reset is finished by the next rerun", () => {
  const { r, before, worktree } = setup();
  assert.equal(cutT1(r, "after| cherry-pick |1").signal, "SIGKILL");
  assert.equal(cutT1(r, "after|reset --keep|1").signal, "SIGKILL");
  const { again, kind } = rerunMeetsBar(r, before, worktree, "R1");
  assert.equal(kind, "rolled-back", again.out);
  finishes(r, "R1");
});

test("a rollback killed before its reset (board files back to HEAD) is finished by the next rerun", () => {
  const { r, before, worktree } = setup();
  assert.equal(cutT1(r, "before|add -- plan/BOARD.md|1").signal, "SIGKILL");
  assert.equal(cutT1(r, "before|reset --keep|1").signal, "SIGKILL");
  const { again, kind } = rerunMeetsBar(r, before, worktree, "R2");
  assert.equal(kind, "rolled-back", again.out);
  finishes(r, "R2");
});

test("while a cut is stuck, another cut, a start and the preview name the cut as the way out", () => {
  const { r } = setup();
  assert.equal(cutT1(r, "after| cherry-pick |1").signal, "SIGKILL");
  const t3 = lane(r, "cut", "T3", "--decision", "D7", "--apply");
  assert.equal(t3.exit, 2);
  assert.match(t3.out, /exec cut T1 --decision <D> --apply rolls back its stuck cut/);
  const start = lane(r, "start", "T2");
  assert.equal(start.exit, 2);
  assert.match(start.out, /exec cut T1 --decision <D> --apply rolls it back/);
  const preview = lane(r, "cut", "T1", "--decision", "D7");
  assert.equal(preview.exit, 2);
  for (const res of [t3, start, preview]) assert.doesNotMatch(res.out, /--resolve/);
});

test("exec close refuses held, building, stuck and rolled-back lanes; a cut lane writes its episode", () => {
  const { r } = setup();
  for (const id of ["T1", "T3"]) assert.equal(lane(r, "close", id).exit, 2, id);
  assert.equal(cutT1(r, "after| cherry-pick |1").signal, "SIGKILL");
  assert.equal(lane(r, "close", "T1").exit, 2, "a stuck cut closed");
  assert.equal(cutT1(r).exit, 1);
  assert.equal(lane(r, "close", "T1").exit, 2, "a rolled-back lane closed");
  assert.equal(ledgerOf(r.root, "T1").episode, undefined);
  finishes(r, "close");
  assert.equal(lane(r, "close", "T1").exit, 0);
  assert.equal(statusOf(r.root, "T1"), "cut");
  assert.ok(!JSON.parse(run(r, LANE, ["session", "close"]).out).episodesPending.includes("T1"));
});

// A red gate that leaves an untracked file on main: the land's rollback refuses over it.
const DIRTY_RED_GATE = ["sh", "-c", "touch coverage.out; exit 1"];
test("a red gate whose rollback refuses names the cut as the way out, never lane merge --resolve", () => {
  const { r, before, worktree } = setup({ gate: DIRTY_RED_GATE });
  const res = cutT1(r);
  assert.equal(res.exit, 1, res.out);
  assert.equal(ledgerOf(r.root, "T1").merge.step, "rollback-refused");
  assert.doesNotMatch(res.out, /--resolve/);
  assert.match(res.out, /then exec cut T1 --decision <D> --apply rolls it back/);
  const again = cutT1(r);
  assert.equal(again.exit, 2);
  assert.match(again.out, /coverage\.out/);
  rmSync(join(r.root, "coverage.out"));
  const { again: third, kind } = rerunMeetsBar(r, before, worktree, "red gate");
  assert.equal(kind, "rolled-back", third.out);
});

// ---- lane merge never lands a stopped cut: the states no kill point reaches --------------------------

test("a stopped cut whose gate rolled back but whose writes did not go back is never landed", () => {
  // The kept commit picked and rolled back off main, the give-back of the set-aside writes red: the
  // ledger stays `merging` at `rolled-back`, a step a land would plan the whole branch from.
  const { r, tip } = setup({ checklist: CHECKLIST });
  assert.equal(cutT1(r, "before|supervise.mjs|1").signal, "SIGKILL");
  const l = ledgerOf(r.root, "T1");
  git(r.root, "reset", "--keep", "--quiet", l.merge.preHead);
  writeFileSync(
    ledgerFile(r.root, "T1"),
    `${JSON.stringify({ ...l, merge: { ...l.merge, step: "rolled-back", landed: [] } }, null, 2)}\n`,
  );
  assert.ok(ledgerOf(r.root, "T1").merge.carry, "the set-aside writes are still held");
  mergeRefusesCut(r, "rolled back");
  assert.equal(git(r.root, "rev-parse", "agentry/T1"), tip);
});

test("lane merge --resolve landed never closes a stopped cut as merged, nor any other mode", () => {
  // The kept commit on main and nothing held aside: a land in this state --resolve landed would close.
  const r = repo({ spec: { ...SPEC, gate: { ...SPEC.gate, checklist: CHECKLIST } } });
  parked(r);
  const preHead = git(r.root, "rev-parse", "HEAD");
  const kept = commitFile(r.root, "art/raw/a.png", "a\n", "chore(art): keep 1 files from T1");
  const l = ledgerOf(r.root, "T1");
  const merge = { cut: true, preHead, planned: [kept], landed: [kept], tip: l.base };
  writeFileSync(
    ledgerFile(r.root, "T1"),
    `${JSON.stringify({ ...l, state: "merging", merge: { ...merge, stateBefore: "held", step: "gated" } }, null, 2)}\n`,
  );
  mergeRefusesCut(r, "--resolve");
  assert.equal(ledgerOf(r.root, "T1").state, "merging");
});

test("lane merge --push and --cleanup on a completed cut refuse and write nothing, no land advertised", () => {
  const r = repo();
  parked(r);
  assert.equal(lane(r, "cut", "T1", "--decision", "D7", "--keep", "art/raw", "--apply").exit, 0);
  const before = snapshot(r);
  for (const args of [["--push", "--approved"], ["--cleanup"]]) {
    const res = run(r, LANE, ["merge", "T1", ...args]);
    assert.equal(res.exit, 2, res.out);
    assert.match(res.out, /T1's lane is closed \(cut\): there is no land to (push|clean up)/);
    assert.doesNotMatch(res.out, /next:|stopped cut/, res.out);
    assert.deepEqual(snapshot(r), before, `merge ${args[0]} changed something`);
  }
  assert.equal(ledgerOf(r.root, "T1").next, null);
});
