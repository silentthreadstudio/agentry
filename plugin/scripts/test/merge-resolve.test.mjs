// Tests for `lane merge <id> --resolve landed|rolled-back` (field 82): the owner closes a land stuck in
// `merging`. Each checks main first and refuses with what it found; neither touches main or the board, and
// the ledger is written once, or not at all.
// Run: node --test plugin/scripts/test/merge-resolve.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
