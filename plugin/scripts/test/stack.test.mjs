// Tests for stacked lanes (lib/lane/stack.mjs, A45) on scratch git repos: what `stackOf` says is due for
// each state of the parent, and `lane exec restack` onto a moved parent, onto main after the parent landed
// and off a stopped one, with a conflict, a branch rebased by hand, a dirty worktree and a hostile git
// config. The lanes are hand-made ledgers over real branches and worktrees.
// Run: node --test plugin/scripts/test/stack.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { childrenOf, stackOf, unclean } from "../lib/lane/stack.mjs";
import { create } from "../lib/lane/worktree.mjs";
import { list, runDir, write as writeLedger } from "../lib/process/ledger.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";
import { writeSpec } from "./spec-files.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};

const SPEC = {
  version: 1,
  name: "Stack",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      contract: { blocks: ["TASKS.md"] },
    },
  },
  rules: [{ rule: "ids-unique" }],
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "true"] }] },
};
const BOARD_MD = `# Stack

## Tasks

| Task | Status |
| ---- | ------ |
| T1   | todo   |
| T2   | todo   |
| T3   | todo   |
`;
const TASKS_MD = `# Tasks

- **T1**: owns \`one.txt\`. Accept: one.txt exists.
- **T2**: owns \`two.txt\`. Accept: two.txt exists.
- **T3**: owns \`three.txt\`. Accept: three.txt exists.
`;

function repo() {
  const root = temp("stack-repo-");
  const home = temp("stack-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  writeSpec(join(root, ".agentry"), SPEC);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  return { root, home };
}
const tipOf = (root, ref) => git(root, "rev-parse", ref);

// A lane `id` with its worktree cut from `base`, each of `files` committed on it, and a hand-made ledger:
// verified PASS on its tip and closed there (next merge) unless `extra` says otherwise. `together` commits
// the files in one commit.
function laneOf(
  r,
  id,
  { base = "main", files = { [`${id}.txt`]: `${id}\n` }, together = false, ...extra } = {},
) {
  const from = tipOf(r.root, base);
  const { path, branch } = create(r.root, { id, base: from });
  if (together) {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", `feat: ${Object.keys(files).length} files`);
  } else
    for (const [file, text] of Object.entries(files)) commitFile(path, file, text, `feat: ${file}`);
  const tip = tipOf(r.root, branch);
  writeFileSync(join(runDir(r.root, id), "contract.md"), `- **${id}**: owns \`${id}.txt\`.\n`);
  return writeLedger(r.root, {
    v: 1,
    id,
    kind: "task",
    contract: { file: "plan/TASKS.md", line: 3 },
    origin: "exec",
    mainBranch: "main",
    base: from,
    worktree: path,
    branch,
    mainAtStart: { head: tipOf(r.root, "main"), porcelain: [], files: {}, modes: true },
    worktreesAtStart: [],
    owned: [{ path: `${id}.txt` }],
    route: { verify: "all", flagged: false },
    rounds: [
      {
        n: 1,
        step: "verify",
        role: "verify",
        mode: "fresh",
        brief: "/b",
        reportPath: "/r",
        tip,
        at: "t",
        report: "/r",
        verdict: "PASS",
      },
    ],
    gates: [],
    checks: {},
    usedMemories: [],
    nested: [],
    closedTip: tip,
    state: "verified",
    next: "merge",
    ...extra,
  });
}
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const setLedger = (root, id, changes) => writeLedger(root, { ...ledgerOf(root, id), ...changes });
const stackFor = (root, id) =>
  stackOf(
    root,
    list(root).find((l) => l.id === id),
    list(root),
  );
function lane({ root, home }, ...args) {
  const res = spawnSync("node", [LANE, "exec", ...args, "--json", "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { exit: res.status, json, out: res.stdout + res.stderr };
}
// T1 at rest, T2 stacked on its tip.
function stacked() {
  const r = repo();
  const t1 = laneOf(r, "T1");
  const t2 = laneOf(r, "T2", { base: t1.branch, on: "T1" });
  return { ...r, t1, t2 };
}
// What a restack that changed nothing must leave as it was: the branch, the worktree's files and index,
// the ledger's bytes, and no rebase in progress.
function snapshot(r, id) {
  const { worktree, branch } = ledgerOf(r.root, id);
  return {
    branch: tipOf(r.root, `refs/heads/${branch}`),
    files: git(worktree, "ls-files", "-s"),
    status: git(worktree, "status", "--porcelain=v1", "--untracked-files=all"),
    hashes: git(worktree, "ls-files", "-z")
      .split("\0")
      .filter(Boolean)
      .map((f) => `${f} ${git(worktree, "hash-object", f)}`),
    ledger: readFileSync(ledgerFile(r.root, id), "utf8"),
    clean: unclean(worktree),
  };
}

test("stackOf: nothing due on the parent's tip, parent when it moved, main when it landed, orphan when it ended", () => {
  const r = stacked();
  const at = r.t1.closedTip.slice(0, 7);
  assert.deepEqual(stackFor(r.root, "T2").due, null);
  assert.equal(stackFor(r.root, "T2").line, `on T1 at ${at}`);
  assert.deepEqual(stackOf(r.root, { id: "T9" }, []), {
    on: null,
    due: null,
    line: null,
    tip: null,
    state: null,
  });
  const moved = commitFile(r.t1.worktree, "one-more.txt", "1\n", "fix: one more");
  const parent = stackFor(r.root, "T2");
  assert.equal(parent.due, "parent");
  assert.equal(
    parent.line,
    `on T1 at ${at}; T1 moved to ${moved.slice(0, 7)} → node '${LANE}' exec restack T2 --root '${r.root}'`,
  );
  setLedger(r.root, "T1", { state: "merged", next: null });
  assert.equal(stackFor(r.root, "T2").due, "main");
  assert.match(stackFor(r.root, "T2").line, /; T1 landed → .*exec restack T2 --root /);
  for (const state of ["stopped", "closed"]) {
    setLedger(r.root, "T1", { state, next: state === "stopped" ? "stop" : null });
    const orphan = stackFor(r.root, "T2");
    assert.equal(orphan.due, "orphan", state);
    assert.match(
      orphan.line,
      new RegExp(
        `; T1 is ${state}: T2 lands only after it, or .*exec restack T2 --root '.*' --main takes it off$`,
      ),
    );
  }
  rmSync(ledgerFile(r.root, "T1"));
  assert.deepEqual([stackFor(r.root, "T2").due, stackFor(r.root, "T2").state], ["orphan", "gone"]);
});

test("a chain T3 on T2 on T1: T1's land makes T2 due main and T3 never main, then parent once T2 moves", () => {
  const r = stacked();
  laneOf(r, "T3", { base: r.t2.branch, on: "T2" });
  assert.deepEqual(childrenOf(list(r.root), "T1"), ["T2"]);
  assert.deepEqual(childrenOf(list(r.root), "T2"), ["T3"]);
  // T1's land: its commit picked onto main, a board commit after it.
  git(r.root, "cherry-pick", r.t1.closedTip);
  commitFile(r.root, "plan/BOARD.md", `${BOARD_MD}\n`, "docs(board): land T1");
  setLedger(r.root, "T1", { state: "merged", next: null });
  assert.equal(stackFor(r.root, "T2").due, "main");
  assert.equal(stackFor(r.root, "T3").due, null);
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  assert.equal(stackFor(r.root, "T2").on, null);
  assert.equal(stackFor(r.root, "T3").due, "parent");
});

test("restack onto a moved parent: the branch replays only its own commits onto the parent's new tip", () => {
  const r = stacked();
  const t2tip = r.t2.closedTip;
  const moved = commitFile(r.t1.worktree, "one-more.txt", "1\n", "fix: one more");
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  const now = tipOf(r.root, "agentry/T2");
  assert.equal(
    res.json.restacked,
    `onto T1 at ${moved.slice(0, 7)} (was ${r.t2.base.slice(0, 7)}): 1 commit(s), no conflict; tip ${t2tip.slice(0, 7)} → ${now.slice(0, 7)}`,
  );
  assert.equal(git(r.root, "rev-parse", "agentry/T2^"), moved, "its one commit sits on T1's tip");
  const ledger = ledgerOf(r.root, "T2");
  assert.deepEqual(
    [ledger.on, ledger.base, ledger.next, ledger.gateTip],
    ["T1", moved, "gate", now],
  );
  assert.deepEqual(ledger.restacks.at(-1), {
    at: ledger.restacks.at(-1).at,
    parent: "T1",
    onto: "parent",
    from: t2tip,
    to: now,
    base: { from: r.t2.base, to: moved },
    resolution: "none",
  });
  assert.equal(res.json.stack, `on T1 at ${moved.slice(0, 7)}`);
});

test("restack onto main after the parent landed: its old commits are gone, git cherry lists only the child's", () => {
  const r = stacked();
  // T1's land: its commit picked onto main (as a commit of its own: -x, so never the same sha), a board
  // commit after it.
  git(r.root, "cherry-pick", "-x", r.t1.closedTip);
  const board = commitFile(r.root, "plan/BOARD.md", `${BOARD_MD}\n`, "docs(board): land T1");
  setLedger(r.root, "T1", { state: "merged", next: null });
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  assert.match(
    res.json.restacked,
    new RegExp(
      `^onto main at ${board.slice(0, 7)} without T1's old commits \\(T1 landed\\): 1 commit\\(s\\), no conflict; tip `,
    ),
  );
  const cherry = git(r.root, "cherry", "main", "agentry/T2").split("\n");
  assert.deepEqual(cherry, [`+ ${tipOf(r.root, "agentry/T2")}`]);
  const ancestor = spawnSync(
    "git",
    ["-C", r.root, "merge-base", "--is-ancestor", r.t1.closedTip, "agentry/T2"],
    { env: gitEnv },
  );
  assert.equal(ancestor.status, 1, "T1's old commit is not under T2 any more");
  const ledger = ledgerOf(r.root, "T2");
  assert.equal(ledger.on, undefined);
  assert.deepEqual([ledger.base, ledger.restacks.at(-1).onto], [board, "main"]);
  assert.equal(res.json.stack, undefined, "no stack line once off the parent");
});

test("a stopped parent: restack is refused without --main; with it the child goes onto main", () => {
  const r = stacked();
  setLedger(r.root, "T1", { state: "stopped", next: "stop" });
  const before = snapshot(r, "T2");
  const refused = lane(r, "restack", "T2");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.out,
    /✗ lane exec restack T2: T1 is stopped: T2 lands only after it, or .*restack T2 --root .* --main takes it off/,
  );
  assert.deepEqual(snapshot(r, "T2"), before);
  const res = lane(r, "restack", "T2", "--main");
  assert.equal(res.exit, 0, res.out);
  assert.match(res.json.restacked, /without T1's old commits \(T1 is stopped\)/);
  assert.equal(git(r.root, "rev-parse", "agentry/T2^"), tipOf(r.root, "main"));
  assert.equal(ledgerOf(r.root, "T1").state, "stopped");
});

test("nothing due: exit 0 with the line, and nothing is written", () => {
  const r = stacked();
  const mtime = statSync(ledgerFile(r.root, "T2")).mtimeMs;
  const before = snapshot(r, "T2");
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  assert.equal(res.json.restack, `nothing to do: T2 is on T1's tip ${r.t2.base.slice(0, 7)}`);
  assert.deepEqual(snapshot(r, "T2"), before);
  assert.equal(statSync(ledgerFile(r.root, "T2")).mtimeMs, mtime);
});

test("a conflicting restack is aborted: branch, files, index and ledger as they were, at most 5 files named", () => {
  const r = repo();
  const files = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [`shared-${i}.txt`, "base\n"]),
  );
  const t1 = laneOf(r, "T1", { files, together: true });
  const mine = Object.fromEntries(Object.keys(files).map((f) => [f, "T2's\n"]));
  laneOf(r, "T2", { base: t1.branch, on: "T1", files: mine, together: true });
  for (const f of Object.keys(files)) commitFile(t1.worktree, f, "T1's\n", `fix: ${f}`);
  const before = snapshot(r, "T2");
  const t1tip = tipOf(r.root, "agentry/T1");
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 1, res.out);
  const tip = before.branch.slice(0, 7);
  const first = git(r.root, "rev-list", "--reverse", `${t1.closedTip}..agentry/T2`).split("\n")[0];
  const named = res.out.match(/\(([^)]*)\): aborted/)[1].split(", ");
  assert.equal(named.length, 5, "the line names at most 5 files");
  assert.match(
    res.out,
    new RegExp(
      `^✗ lane exec restack T2: ${first.slice(0, 7)} feat: 7 files conflicts on agentry/T1 at ${t1tip.slice(0, 7)} \\(shared-0\\.txt, .*\\): aborted, agentry/T2 is back at ${tip} → resolve it in ${ledgerOf(r.root, "T2").worktree}: git rebase --onto agentry/T1 ${t1.closedTip.slice(0, 7)}, then .*exec restack T2 --root `,
    ),
  );
  assert.deepEqual(snapshot(r, "T2"), before);
  assert.deepEqual(before.clean, [], "no rebase in progress");
});

test("a branch rebased by hand (or by a restack killed before its ledger write) is recorded by hand", () => {
  const r = stacked();
  const verified = r.t2.closedTip;
  const moved = commitFile(r.t1.worktree, "one-more.txt", "1\n", "fix: one more");
  git(r.t2.worktree, "rebase", "-q", "--onto", "agentry/T1", r.t2.base);
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  assert.match(res.json.restacked, /1 commit\(s\), resolved by hand; tip /);
  const ledger = ledgerOf(r.root, "T2");
  const entry = ledger.restacks.at(-1);
  assert.deepEqual(
    [entry.resolution, entry.from, entry.to, entry.base.to],
    ["by hand", verified, tipOf(r.root, "agentry/T2"), moved],
  );
  assert.ok(existsSync(entry.rangeDiff), "the restack's range-diff is written for the recheck");
  // A verified lane resolved by hand gets the resolution recheck: a fresh verifier.
  assert.deepEqual([res.json.next, res.json.role, res.json.mode], ["resolve", "verify", "fresh"]);
  assert.match(readFileSync(res.json.brief, "utf8"), /rebased\nonto `agentry\/T1`/);
  assert.match(readFileSync(res.json.brief, "utf8"), new RegExp(entry.rangeDiff));
});

test("a restack writes its plan before the rebase; a rerun after a kill uses it though the parent moved again", () => {
  const r = stacked();
  const t2tip = r.t2.closedTip;
  const first = commitFile(r.t1.worktree, "one-more.txt", "1\n", "fix: one more");
  // A pre-rebase hook copies the ledger as it is when git starts the rebase.
  const seen = join(r.home, "during.json");
  const hook = join(r.root, ".git", "hooks", "pre-rebase");
  writeFileSync(hook, `#!/bin/sh\ncp '${ledgerFile(r.root, "T2")}' '${seen}'\n`, { mode: 0o755 });
  assert.equal(lane(r, "restack", "T2").exit, 0);
  assert.deepEqual(
    (({ target, onto, ontoName, base, from }) => ({ target, onto, ontoName, base, from }))(
      JSON.parse(readFileSync(seen, "utf8")).restacking,
    ),
    { target: "parent", onto: first, ontoName: "agentry/T1", base: r.t2.base, from: t2tip },
  );
  assert.equal(ledgerOf(r.root, "T2").restacking, undefined, "the plan goes once it is recorded");
  rmSync(hook);

  // A restack killed after its rebase, before its record: the plan in the ledger, the branch moved.
  const r2 = stacked();
  const moved = commitFile(r2.t1.worktree, "one-more.txt", "1\n", "fix: one more");
  const plan = {
    target: "parent",
    onto: moved,
    ontoName: "agentry/T1",
    base: r2.t2.base,
    from: r2.t2.closedTip,
    why: "T1 is verified",
    at: "2026-11-03T10:00:00.000Z",
  };
  setLedger(r2.root, "T2", { restacking: plan });
  git(r2.t2.worktree, "rebase", "-q", "--onto", "agentry/T1", r2.t2.base);
  const killedAt = tipOf(r2.root, "agentry/T2");
  // The parent moves again before the rerun.
  const again = commitFile(r2.t1.worktree, "one-more.txt", "2\n", "fix: again");
  const rerun = lane(r2, "restack", "T2");
  assert.equal(rerun.exit, 0, rerun.out);
  assert.match(
    rerun.json.restacked,
    /^onto T1 at \w{7} \(was \w{7}\): 1 commit\(s\), resolved by hand; /,
  );
  const entry = ledgerOf(r2.root, "T2").restacks.at(-1);
  assert.deepEqual(
    [entry.resolution, entry.from, entry.to, entry.base],
    ["by hand", r2.t2.closedTip, killedAt, { from: r2.t2.base, to: moved }],
  );
  assert.equal(ledgerOf(r2.root, "T2").restacking, undefined);
  // The next restack replays only T2's own commit onto T1's newest tip: no T1 commit is named as T2's.
  setLedger(r2.root, "T2", {
    state: "verifying",
    next: "gate",
    rounds: ledgerOf(r2.root, "T2").rounds.slice(0, 1),
  });
  const next = lane(r2, "restack", "T2");
  assert.equal(next.exit, 0, next.out);
  assert.match(next.json.restacked, /: 1 commit\(s\), no conflict;/);
  assert.equal(tipOf(r2.root, "agentry/T2^"), again);
});

test("a restack killed mid-rebase is refused on the rerun, its entries led by rebase in progress", () => {
  const r = repo();
  const t1 = laneOf(r, "T1", { files: { "shared.txt": "base\n" } });
  laneOf(r, "T2", { base: t1.branch, on: "T1", files: { "shared.txt": "T2's\n" } });
  commitFile(t1.worktree, "shared.txt", "T1's\n");
  const { worktree } = ledgerOf(r.root, "T2");
  // The stop a killed restack leaves: git mid-rebase on a conflict.
  const stopped = spawnSync(
    "git",
    ["-C", worktree, "rebase", "--onto", "agentry/T1", t1.closedTip],
    { env: gitEnv, encoding: "utf8" },
  );
  assert.notEqual(stopped.status, 0);
  const ledger = readFileSync(ledgerFile(r.root, "T2"), "utf8");
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 2);
  assert.match(
    res.out,
    new RegExp(
      `the worktree ${worktree} is not clean \\(rebase in progress, UU shared\\.txt\\): commit or remove them, then restack`,
    ),
  );
  assert.equal(readFileSync(ledgerFile(r.root, "T2"), "utf8"), ledger);
});

test("refusals: an agent out, the gate running in the lane's worktree, a dirty worktree; nothing changes", () => {
  const r = stacked();
  commitFile(r.t1.worktree, "one-more.txt", "1\n", "fix: one more");
  const check = (pattern) => {
    const before = snapshot(r, "T2");
    const res = lane(r, "restack", "T2");
    assert.equal(res.exit, 2, res.out);
    assert.match(res.out, pattern);
    assert.deepEqual(snapshot(r, "T2"), before);
  };
  const ledger = ledgerOf(r.root, "T2");
  setLedger(r.root, "T2", {
    state: "fixing",
    next: "fix",
    rounds: [...ledger.rounds, { n: 2, step: "fix", role: "build", mode: "resume", tip: "x" }],
  });
  check(
    /✗ lane exec restack T2: a build round is out \(round 2, next fix\): restack when the lane is at its gate, close or merge, or held/,
  );
  writeLedger(r.root, ledger);
  // A slot of the gate lock held by a running process for this lane.
  const locks = join(r.root, ".agentry", "run", "gate-locks");
  mkdirSync(locks, { recursive: true });
  writeFileSync(
    join(locks, "slot-1.lock"),
    JSON.stringify({ pid: process.pid, who: "lane T2", at: new Date().toISOString() }),
  );
  check(/✗ lane exec restack T2: a gate for T2 is queued or running: restack after it$/m);
  rmSync(join(locks, "slot-1.lock"));
  writeFileSync(join(r.t2.worktree, "stray.txt"), "x\n");
  check(
    new RegExp(
      `the worktree ${r.t2.worktree} is not clean \\(\\?\\? stray\\.txt\\): commit or remove them, then restack`,
    ),
  );
  rmSync(join(r.t2.worktree, "stray.txt"));
  // Not stacked, or a step that takes no --main.
  const plain = laneOf(r, "T3");
  assert.match(lane(r, "restack", plain.id).out, /T3 is not stacked on a lane/);
  assert.equal(lane(r, "gate", "T2", "--main").exit, 2);
});

test("a hostile git config: a dirty worktree still refused, nothing squashed, no other ref moved", () => {
  const r = repo();
  for (const key of ["rebase.autoStash", "rebase.autoSquash", "rebase.updateRefs"])
    git(r.root, "config", key, "true");
  const t1 = laneOf(r, "T1");
  laneOf(r, "T2", {
    base: t1.branch,
    on: "T1",
    files: { "two.txt": "2\n", "three.txt": "3\n" },
  });
  // A fixup! commit autoSquash would fold, and a ref on a commit inside the range updateRefs would move.
  const { worktree } = ledgerOf(r.root, "T2");
  commitFile(worktree, "two.txt", "2 fixed\n", "fixup! feat: two.txt");
  git(r.root, "branch", "inside", "agentry/T2~1");
  const inside = tipOf(r.root, "inside");
  setLedger(r.root, "T2", { closedTip: tipOf(r.root, "agentry/T2") });
  commitFile(t1.worktree, "one-more.txt", "1\n", "fix: one more");
  const t1tip = tipOf(r.root, "agentry/T1");
  writeFileSync(join(worktree, "two.txt"), "dirty\n");
  const dirty = lane(r, "restack", "T2");
  assert.equal(dirty.exit, 2);
  assert.match(dirty.out, /is not clean \( M two\.txt\)/);
  assert.equal(readFileSync(join(worktree, "two.txt"), "utf8"), "dirty\n", "nothing stashed");
  git(worktree, "checkout", "--", "two.txt");
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  assert.match(res.json.restacked, /: 3 commit\(s\), no conflict/);
  assert.deepEqual(git(r.root, "log", "--format=%s", "agentry/T1..agentry/T2").split("\n"), [
    "fixup! feat: two.txt",
    "feat: three.txt",
    "feat: two.txt",
  ]);
  assert.deepEqual([tipOf(r.root, "inside"), tipOf(r.root, "agentry/T1")], [inside, t1tip]);
});

// ---- R1d-14 final N1, N2 and resolve N1, N2 ---------------------------------------------------------

test("a stale restack plan plus a hand commit is never read as a finished restack: its old base is still there", () => {
  const r = stacked();
  // A restack killed before its rebase: the plan onto main, the branch where it was.
  const plan = {
    target: "main",
    onto: tipOf(r.root, "main"),
    ontoName: "main",
    base: r.t2.base,
    from: r.t2.closedTip,
    why: "T1 is verified",
    at: "2026-11-03T10:00:00.000Z",
  };
  setLedger(r.root, "T2", { restacking: plan });
  commitFile(r.t2.worktree, "two-more.txt", "2\n", "fix: by hand");
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  assert.match(res.json.restack, /^nothing to do: T2 is on T1's tip \w{7}$/);
  const ledger = ledgerOf(r.root, "T2");
  assert.deepEqual([ledger.restacks, ledger.base], [undefined, r.t2.base]);
});

test("exec rebase on a lane stacked on an unmerged parent is refused, nothing changed", () => {
  const r = stacked();
  const before = snapshot(r, "T2");
  const res = lane(r, "rebase", "T2");
  assert.equal(res.exit, 2);
  assert.match(
    res.out,
    /✗ lane exec rebase T2: T2 is stacked on T1: restack it \(.*exec restack T2 --root .*\), never rebase it onto main/,
  );
  assert.deepEqual(snapshot(r, "T2"), before);
});
