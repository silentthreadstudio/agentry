// Tests for `lane merge <id> --resolve landed|rolled-back` (field 82): the owner closes a land stuck in
// `merging`. Each checks main first and refuses with what it found; neither touches main or the board, and
// the ledger is written once, or not at all.
// Run: node --test plugin/scripts/test/merge-resolve.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256 } from "../lib/lane/carry-io.mjs";
import { create } from "../lib/lane/worktree.mjs";
import { read as readLedger, write as writeLedger } from "../lib/process/ledger.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";
import { writeSpec } from "./spec-files.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const ID = "T1";

const SPEC = {
  version: 1,
  name: "Resolve",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" }, commit: { column: "Commit", type: "commits" } },
      status: { field: "status", values: { todo: "planned", verify: "active", done: "done" } },
    },
  },
  rules: [{ rule: "ids-unique" }],
  lifecycle: {
    kind: "task",
    on: { merged: "done" },
    write: { status: "status", commit: "commit" },
  },
  gate: { tiers: [{ name: "full", command: ["node", "-e", "0"] }] },
};
const BOARD_MD = `# Resolve

## Tasks

| Task | Status | Commit |
| ---- | ------ | ------ |
| T1   | verify |        |
`;

let root;
let home;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "resolve-home-")));
  root = realpathSync(mkdtempSync(join(tmpdir(), "resolve-repo-")));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".agentry/run/\n");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "BOARD.md"), BOARD_MD);
  mkdirSync(join(root, ".agentry"), { recursive: true });
  writeSpec(join(root, ".agentry"), SPEC);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const merge = (...args) =>
  spawnSync("node", [LANE, "merge", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });
const out = (res) => res.stdout + res.stderr;
const head = () => git(root, "rev-parse", "HEAD");
const status = () => git(root, "status", "--porcelain", "--untracked-files=all");
const ledgerDir = () => join(root, ".agentry", "run", "process", "ledger");
const ledgerBytes = () => readFileSync(join(ledgerDir(), `${ID}.json`), "utf8");

/** A land stuck in `merging` (field 82: picked and gated, its record stopped): `picks` of the branch's two
 *  commits are cherry-picked onto main, and the ledger says all of them landed. */
function stuckLand({ picks = 2 } = {}) {
  const { path } = create(root, { id: ID, base: "main" });
  const shas = [commitFile(path, "src/a.txt", "a\n"), commitFile(path, "src/b.txt", "b\n")];
  const preHead = head();
  git(root, "cherry-pick", ...shas.slice(0, picks));
  const landed = git(root, "rev-list", "--reverse", `${preHead}..HEAD`).split("\n").filter(Boolean);
  writeLedger(root, {
    v: 1,
    id: ID,
    kind: "task",
    contract: { file: "plan/TASKS.md", line: 1 },
    origin: "exec",
    mainBranch: "main",
    base: preHead,
    worktree: path,
    branch: `agentry/${ID}`,
    mainAtStart: { head: preHead, porcelain: [] },
    worktreesAtStart: [],
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    state: "merging",
    next: "fix what the finding names, then land again (the picks stay; it resumes)",
    merge: {
      preHead,
      planned: shas,
      landed: picks === 2 ? landed : [...landed, shas[1]],
      tip: shas[1],
      stateBefore: "verified",
      step: "gated",
      gate: { tier: "full", detail: "full ran on main" },
      at: "2026-11-01T00:00:00.000Z",
    },
  });
  return { preHead, landed, shas };
}

test("--resolve landed with every pick on main sets the ledger merged with the picks, and touches nothing else", () => {
  const { landed } = stuckLand();
  const [before, board] = [head(), readFileSync(join(root, "plan", "BOARD.md"), "utf8")];
  const res = merge(ID, "--resolve", "landed");
  assert.equal(res.status, 0, out(res));
  assert.match(
    res.stdout,
    /✓ resolve +resolved: 2 pick\(s\) on main; ledger merged \(the board record is yours: board set … and the handoff line\)/,
  );
  const ledger = readLedger(root, ID);
  assert.equal(ledger.state, "merged");
  assert.deepEqual(ledger.merge.landed, landed);
  assert.equal(ledger.merge.boardCommit, null);
  assert.equal(ledger.merge.resolved.as, "landed");
  assert.equal(ledger.next, res.stdout.match(/next: (.*)/)[1]);
  assert.equal(head(), before);
  assert.equal(readFileSync(join(root, "plan", "BOARD.md"), "utf8"), board);
  assert.equal(status(), "");
  // One write: no temporary ledger file left beside it.
  assert.deepEqual(readdirSync(ledgerDir()), [`${ID}.json`]);
});

test("--resolve landed with one pick missing from main refuses and changes nothing", () => {
  const { shas } = stuckLand({ picks: 1 });
  const [before, ledger] = [head(), ledgerBytes()];
  const res = merge(ID, "--resolve", "landed");
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    new RegExp(`✗ resolve +${shas[1].slice(0, 7)} is not on main: not landed`),
  );
  assert.equal(ledgerBytes(), ledger);
  assert.equal(head(), before);
});

test("--resolve rolled-back with no pick on main clears merge and returns the lane to verified", () => {
  const { preHead } = stuckLand();
  git(root, "reset", "-q", "--keep", preHead); // the owner took the picks off by hand
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ resolve +resolved: no pick on main/);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.state, "verified");
  assert.equal(ledger.merge, undefined);
  assert.equal(head(), preHead);
  assert.equal(status(), "");
});

test("--resolve rolled-back with a pick on main refuses, naming it", () => {
  const { landed } = stuckLand();
  const ledger = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    new RegExp(`✗ resolve +${landed[0].slice(0, 7)} is on main: not rolled back`),
  );
  assert.equal(ledgerBytes(), ledger);
});

test("--resolve rolled-back finds a pick a land killed while picking left before it recorded any", () => {
  const { landed } = stuckLand({ picks: 1 });
  const ledger = JSON.parse(ledgerBytes());
  writeLedger(root, { ...ledger, merge: { ...ledger.merge, step: "picking", landed: [] } });
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), new RegExp(`${landed[0].slice(0, 7)} is on main: not rolled back`));
  assert.equal(ledgerBytes(), before);
});

test("--resolve on a ledger not in merging refuses and writes nothing", () => {
  stuckLand();
  const ledger = JSON.parse(ledgerBytes());
  writeLedger(root, { ...ledger, state: "verified" });
  const before = ledgerBytes();
  for (const as of ["landed", "rolled-back"]) {
    const res = merge(ID, "--resolve", as);
    assert.equal(res.status, 2, out(res));
    assert.match(out(res), /T1's lane is "verified": --resolve closes only a land in "merging"/);
    assert.equal(ledgerBytes(), before);
  }
});

test("--resolve refuses while the ledger holds files the land set aside, and a value it does not know", () => {
  stuckLand();
  const ledger = JSON.parse(ledgerBytes());
  const allow = { enc: "bytes", files: ["NOTES.md"], untracked: [], patch: "", sha256: "" };
  writeLedger(root, { ...ledger, merge: { ...ledger.merge, allow } });
  const before = ledgerBytes();
  const held = merge(ID, "--resolve", "landed");
  assert.equal(held.status, 2, out(held));
  assert.match(out(held), /the ledger still holds what the land set aside \(merge\.allow\)/);
  const bad = merge(ID, "--resolve", "maybe");
  assert.equal(bad.status, 2, out(bad));
  assert.match(out(bad), /--resolve takes landed or rolled-back, not "maybe"/);
  assert.equal(ledgerBytes(), before);
});

test("--resolve landed names each lane stacked on it with its restack command, and restacks none", () => {
  stuckLand();
  const ledger = JSON.parse(ledgerBytes());
  const { merge: _, ...rest } = ledger;
  const child = { ...rest, id: "T2", branch: "agentry/T2", on: ID, state: "verified" };
  writeLedger(root, child);
  const before = readFileSync(join(ledgerDir(), "T2.json"), "utf8");
  const res = merge(ID, "--resolve", "landed");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /! stack +T2 is stacked on T1: agentry lane exec restack T2 --main/);
  assert.equal(readFileSync(join(ledgerDir(), "T2.json"), "utf8"), before);
});

/** stuckLand, then the ledger as a land killed while picking: both picks on main, none recorded. */
function killedWhilePicking() {
  const s = stuckLand();
  const ledger = readLedger(root, ID);
  const { landed: _, gate: __, ...merge } = ledger.merge;
  writeLedger(root, { ...ledger, merge: { ...merge, step: "picking" } });
  return s;
}

// Verifier r3, probes A, B, B2: picks found by position hid them behind any owner commit since preHead.
test("--resolve rolled-back refuses while a land killed picking left its picks on main, an owner commit on top", () => {
  const { landed } = killedWhilePicking();
  commitFile(root, "notes.txt", "owner\n", "docs: owner note");
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), new RegExp(`${landed[0].slice(0, 7)} is on main: not rolled back`));
  assert.equal(ledgerBytes(), before);
});

test("--resolve rolled-back refuses with one pick on main and an owner commit after it", () => {
  const { landed } = killedWhilePicking();
  git(root, "reset", "-q", "--keep", "HEAD~1"); // main: preHead and the first pick only
  commitFile(root, "notes.txt", "owner\n", "docs: owner note");
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), new RegExp(`${landed[0].slice(0, 7)} is on main: not rolled back`));
  assert.equal(ledgerBytes(), before);
});

test("--resolve rolled-back refuses with both picks of a land killed picking on main and nothing on top", () => {
  killedWhilePicking();
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /is on main: not rolled back/);
  assert.equal(ledgerBytes(), before);
});

test("--resolve rolled-back refuses when git cannot tell what is on main, never reading it as none", () => {
  const { preHead } = killedWhilePicking();
  git(root, "reset", "-q", "--keep", preHead);
  const ledger = readLedger(root, ID);
  writeLedger(root, { ...ledger, merge: { ...ledger.merge, planned: ["0".repeat(40)] } });
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /cannot tell whether a pick is on main \(.+\): not rolled back/);
  assert.equal(ledgerBytes(), before);
});

// Verifier r3, N1 (probe E): a land killed while it wrote the board left its writes on main.
test("--resolve refuses at recording while the record's board writes sit uncommitted on main", () => {
  stuckLand();
  const ledger = readLedger(root, ID);
  const file = join(root, "plan", "BOARD.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("| verify |", "| done   |"));
  const record = { files: ["plan/BOARD.md"], sha256: {}, base: {} };
  writeLedger(root, { ...ledger, merge: { ...ledger.merge, step: "recording", record } });
  const before = ledgerBytes();
  for (const as of ["landed", "rolled-back"]) {
    const res = merge(ID, "--resolve", as);
    assert.equal(res.status, 2, out(res));
    assert.match(
      out(res),
      /plan\/BOARD\.md hold this land's board writes, uncommitted: rerun lane merge T1 to finish the record, or put them back first/,
    );
    assert.equal(ledgerBytes(), before);
  }
  assert.equal(status(), "M plan/BOARD.md");
});

// --- verifier r5: a pick on main its patch id does not match (P1, P2, P3; C0 the control) -------------

const F = "1\n2\n3\n4\n5\n6\n7\n8\n";
/** Commit `src/f.txt` with line `n` replaced by `text` in `dir`: the commit's SHA. */
const editF = (dir, n, text, subject) =>
  commitFile(dir, "src/f.txt", F.replace(`${n}\n`, `${text}\n`), subject);
const patchId = (sha) =>
  spawnSync("git", ["-C", root, "patch-id", "--stable"], {
    input: git(root, "show", sha),
    encoding: "utf8",
    env: gitEnv,
  }).stdout.split(" ")[0];
/** The branch, cut from main with `src/f.txt` on it, and the ledger of a land killed while picking. */
function laneWithF() {
  commitFile(root, "src/f.txt", F);
  return create(root, { id: ID, base: "main" }).path;
}
function killedLedger({ preHead, planned, path }) {
  writeLedger(root, {
    v: 1,
    id: ID,
    kind: "task",
    contract: { file: "plan/TASKS.md", line: 1 },
    origin: "exec",
    mainBranch: "main",
    base: preHead,
    worktree: path,
    branch: `agentry/${ID}`,
    mainAtStart: { head: preHead, porcelain: [] },
    worktreesAtStart: [],
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    state: "merging",
    next: "fix what the finding names, then land again (the picks stay; it resumes)",
    merge: {
      preHead,
      planned,
      tip: planned.at(-1),
      stateBefore: "verified",
      step: "picking",
      at: "2026-11-01T00:00:00.000Z",
    },
  });
}

test("--resolve rolled-back refuses a pick on main whose context lines, so its patch id, differ", () => {
  const path = laneWithF();
  const lane = editF(path, 5, "five", "feat: lane edit");
  const preHead = editF(root, 2, "two", "chore: owner edit before the land");
  git(root, "cherry-pick", lane);
  const pick = head();
  assert.notEqual(patchId(pick), patchId(lane)); // the fixture: only the identity matches
  killedLedger({ preHead, planned: [lane], path });
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), new RegExp(`${pick.slice(0, 7)} is on main: not rolled back`));
  assert.equal(ledgerBytes(), before);
});

test("--resolve rolled-back refuses a pick the owner resolved by hand and continued", () => {
  const path = laneWithF();
  const lane = editF(path, 3, "lane", "feat: lane edit");
  const preHead = editF(root, 3, "owner", "chore: owner edit before the land");
  const picked = spawnSync("git", ["-C", root, "cherry-pick", lane], { env: gitEnv });
  assert.notEqual(picked.status, 0); // the fixture: the pick conflicts
  writeFileSync(join(root, "src", "f.txt"), F.replace("3\n", "owner+lane\n"));
  git(root, "add", "src/f.txt");
  git(root, "-c", "core.editor=true", "cherry-pick", "--continue");
  const pick = head();
  assert.notEqual(pick, preHead);
  killedLedger({ preHead, planned: [lane], path });
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), new RegExp(`${pick.slice(0, 7)} is on main: not rolled back`));
  assert.equal(ledgerBytes(), before);
});

test("--resolve rolled-back refuses when the owner merged the branch itself (--no-ff)", () => {
  const path = laneWithF();
  const lane = editF(path, 5, "five", "feat: lane edit");
  const preHead = head();
  git(root, "merge", "-q", "--no-ff", "-m", "merge lane by hand", `agentry/${ID}`);
  killedLedger({ preHead, planned: [lane], path });
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), new RegExp(`${lane.slice(0, 7)} is on main: not rolled back`));
  assert.equal(ledgerBytes(), before);
});

test("--resolve rolled-back resolves once that pick is reset off main, an owner commit after", () => {
  const path = laneWithF();
  const lane = editF(path, 5, "five", "feat: lane edit");
  const preHead = editF(root, 2, "two", "chore: owner edit before the land");
  git(root, "cherry-pick", lane);
  git(root, "reset", "-q", "--keep", preHead);
  commitFile(root, "notes.txt", "owner\n", "docs: owner note");
  killedLedger({ preHead, planned: [lane], path });
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 0, out(res));
  assert.equal(readLedger(root, ID).state, "verified");
});

// Verifier r5, N7: a ledger value went to git log as a revision, so `--output=<file>` wrote a file.
test("--resolve refuses a ledger value that is not a full commit sha before any git call", () => {
  const { preHead } = stuckLand();
  git(root, "reset", "-q", "--keep", preHead);
  const target = join(home, "written-by-git-log");
  const ledger = readLedger(root, ID);
  const { landed: _, ...rest } = ledger.merge;
  writeLedger(root, {
    ...ledger,
    merge: { ...rest, step: "picking", planned: [`--output=${target}`] },
  });
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    new RegExp(`ledger value --output=${target} is not a commit sha: not rolled back`),
  );
  assert.equal(existsSync(target), false);
  assert.equal(ledgerBytes(), before);
});

// Verifier r5, N6: the owner took the picks back with git revert; the refusal names the way on.
test("--resolve rolled-back after a revert of the picks refuses, naming --resolve landed", () => {
  const { landed } = stuckLand();
  git(root, "revert", "--no-edit", landed[1], landed[0]);
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    /is on main: not rolled back → if you reverted it, the picks are still on main: --resolve landed, then record the board by hand/,
  );
  assert.equal(ledgerBytes(), before);
});

// S32: a land killed after its board commit, before the step moved on: that commit is the ledger's.
test("--resolve landed with the record's board commit already on HEAD records it as boardCommit", () => {
  stuckLand();
  const text = readFileSync(join(root, "plan", "BOARD.md"), "utf8").replace(
    "| verify |",
    "| done   |",
  );
  const board = commitFile(root, "plan/BOARD.md", text, "chore(board): T1 done");
  const ledger = readLedger(root, ID);
  const record = { files: ["plan/BOARD.md"], sha256: { "plan/BOARD.md": sha256(text) } };
  writeLedger(root, { ...ledger, merge: { ...ledger.merge, step: "recording", record } });
  const res = merge(ID, "--resolve", "landed");
  assert.equal(res.status, 0, out(res));
  assert.match(
    res.stdout,
    new RegExp(
      `✓ resolve +resolved: 2 pick\\(s\\) and the board commit ${board.slice(0, 7)} on main`,
    ),
  );
  const after = readLedger(root, ID);
  assert.deepEqual([after.state, after.merge.boardCommit], ["merged", board]);
  assert.equal(head(), board);
});

test("--resolve landed at recording with a commit the record does not prove keeps boardCommit null", () => {
  stuckLand();
  commitFile(root, "notes.txt", "owner\n", "docs: owner note");
  const ledger = readLedger(root, ID);
  const record = { files: ["plan/BOARD.md"], sha256: { "plan/BOARD.md": "0".repeat(64) } };
  writeLedger(root, { ...ledger, merge: { ...ledger.merge, step: "recording", record } });
  const res = merge(ID, "--resolve", "landed");
  assert.equal(res.status, 0, out(res));
  assert.equal(readLedger(root, ID).merge.boardCommit, null);
});

// S33 N9 (verifier R1d-34 r7, Q2): the owner re-picked the land's commit by hand with -x on a drifted main.
test("--resolve rolled-back refuses a pick made by hand with -x, by the planned sha its message names", () => {
  const path = laneWithF();
  const lane = editF(path, 5, "five", "feat: lane edit");
  const preHead = editF(root, 2, "two", "chore: owner edit before the land"); // the patch id differs
  git(root, "cherry-pick", "-x", lane);
  git(
    root,
    "commit",
    "-q",
    "--amend",
    "-m",
    `feat: lane edit, by hand\n\n(cherry picked from commit ${lane})`,
  ); // so does the identity
  const pick = head();
  assert.notEqual(patchId(pick), patchId(lane));
  killedLedger({ preHead, planned: [lane], path });
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), new RegExp(`${pick.slice(0, 7)} is on main: not rolled back`));
  assert.equal(ledgerBytes(), before);
});

// S33 N9 (Q3, Q4): no pick found, but main changed the files the picks change: only the owner can tell.
test("--resolve rolled-back refuses when main changed a planned file with no pick found (a squash)", () => {
  const path = laneWithF();
  const first = editF(path, 5, "five", "feat: lane edit");
  const second = commitFile(
    path,
    "src/f.txt",
    F.replace("5\n", "five\n").replace("7\n", "seven\n"),
  );
  const preHead = head();
  git(root, "merge", "-q", "--squash", `agentry/${ID}`);
  git(root, "commit", "-q", "-m", "squash the lane's two commits by hand");
  killedLedger({ preHead, planned: [first, second], path });
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    /src\/f\.txt changed on main since this land began: check by hand, then --resolve rolled-back --checked$/m,
  );
  assert.equal(ledgerBytes(), before);
  // The owner checked it by hand: --checked skips that refusal alone, and says so in the ledger.
  const checked = merge(ID, "--resolve", "rolled-back", "--checked");
  assert.equal(checked.status, 0, out(checked));
  assert.match(
    checked.stdout,
    /resolved: no pick on main; .* \(the changed planned files checked by hand\)/,
  );
  const ledger = readLedger(root, ID);
  assert.deepEqual(
    [ledger.state, ledger.merge, ledger.resolved],
    ["verified", undefined, undefined],
  );
  assert.equal(ledger.resolutions.length, 1);
  const [{ at, ...entry }] = ledger.resolutions;
  assert.deepEqual(entry, { as: "rolled-back", checked: true });
  assert.match(at, /^\d{4}-\d\d-\d\dT/);
  // A later checked resolve appends; it never replaces the earlier record (R1d-39 r4 N3).
  writeLedger(root, { ...ledger, state: "merging", merge: JSON.parse(before).merge });
  assert.equal(merge(ID, "--resolve", "rolled-back", "--checked").status, 0);
  assert.equal(readLedger(root, ID).resolutions.length, 2);
});

test("--checked never skips the pick checks, and goes with rolled-back only", () => {
  const { landed } = stuckLand();
  const before = ledgerBytes();
  const picked = merge(ID, "--resolve", "rolled-back", "--checked");
  assert.equal(picked.status, 2, out(picked));
  assert.match(out(picked), new RegExp(`${landed[0].slice(0, 7)} is on main: not rolled back`));
  const landedToo = merge(ID, "--resolve", "landed", "--checked");
  assert.equal(landedToo.status, 2, out(landedToo));
  assert.match(out(landedToo), /--checked goes with --resolve rolled-back only/);
  const stray = merge(ID, "--preflight", "--checked");
  assert.equal(stray.status, 2, out(stray));
  assert.match(out(stray), /--checked does not go with --preflight/);
  assert.equal(ledgerBytes(), before);
});

test("--resolve rolled-back never warns of changed files when main changed none the picks change", () => {
  const path = laneWithF();
  const lane = editF(path, 5, "five", "feat: lane edit");
  const preHead = head();
  commitFile(root, "src/other.txt", "owner\n", "feat: owner change elsewhere");
  killedLedger({ preHead, planned: [lane], path });
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 0, out(res));
  assert.doesNotMatch(out(res), /changed on main since this land began/);
  assert.equal(readLedger(root, ID).state, "verified");
});

// S33 N10 (Q1, Q5): with nothing recorded as landed, `--resolve landed` refuses too: name the reset instead.
test("--resolve rolled-back with no landed pick names the reset to preHead, never --resolve landed", () => {
  const { preHead } = killedWhilePicking();
  const before = ledgerBytes();
  const res = merge(ID, "--resolve", "rolled-back");
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    new RegExp(
      `is on main: not rolled back → git reset --keep ${preHead.slice(0, 7)}, then --resolve rolled-back`,
    ),
  );
  assert.doesNotMatch(out(res), /--resolve landed/);
  assert.equal(ledgerBytes(), before);
});

// S33 N11 (Q6b): a bare sha in planned read as no pick, and resolved "no pick on main" with it on main.
test("--resolve refuses a planned or landed that is not a list, before any git call", () => {
  const { shas } = killedWhilePicking();
  const ledger = readLedger(root, ID);
  for (const key of ["planned", "landed"]) {
    writeLedger(root, { ...ledger, merge: { ...ledger.merge, [key]: shas[0] } });
    const before = ledgerBytes();
    for (const as of ["landed", "rolled-back"]) {
      const res = merge(ID, "--resolve", as);
      assert.equal(res.status, 2, out(res));
      assert.match(
        out(res),
        new RegExp(`ledger value merge\\.${key} is not a list of commit shas`),
      );
      assert.equal(ledgerBytes(), before);
    }
  }
});
