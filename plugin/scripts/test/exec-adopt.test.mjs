// Tests for `lane exec adopt <id> --branch <b>` (field 86) on temp git repos: work built outside exec becomes
// the lane, with `start`'s checks and records, `main..<b>` picked onto a fresh `agentry/<id>` and the
// uncommitted diff of `<b>`'s worktree applied; `<b>` and its worktree are never touched; every refusal
// writes nothing; a carried conflict stops as `restart --carry` does.
// Run: node --test plugin/scripts/test/exec-adopt.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
  name: "Adopt",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" }, verdict: { column: "Verdict" } },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
      contract: { blocks: ["TASKS.md"] },
    },
  },
  rules: [{ rule: "ids-unique" }],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: { status: "status", verdict: "verdict" },
  },
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "true"] }] },
};
const BOARD_MD = `# Adopt

## Tasks

| Task | Status | Verdict |
| ---- | ------ | ------- |
| T1   | todo   |         |
| T2   | todo   |         |
`;
const TASKS_MD = `# Tasks

### T1 · Three

- **Owns:** \`three.txt\`, \`more.txt\`. Accept: three.txt holds the change.

### T2 · Four

- **Owns:** \`four.txt\`. Accept: four.txt exists.
`;

function repo({ config } = {}) {
  const root = temp("adopt-repo-");
  const home = temp("adopt-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "three.txt", "a\nb\nc\n");
  writeSpec(join(root, ".agentry"), SPEC);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  if (config) writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify(config));
  return { root, home };
}
const spawnLane = ({ root, home }, args) =>
  spawnSync("node", [LANE, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
function lane(r, ...args) {
  const res = spawnLane(r, ["exec", ...args, "--json"]);
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* a refusal on stderr */
  }
  return { exit: res.status, json, stderr: res.stderr };
}
const processDir = (root) => join(root, ".agentry", "run", "process");
const ledgerFile = (root, id) => join(processDir(root), "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const tipOf = (root, ref) => git(root, "rev-parse", ref);
const hasRef = (root, ref) =>
  spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", ref], { env: gitEnv })
    .status === 0;
const board = (root) => readFileSync(join(root, "plan", "BOARD.md"), "utf8");
// What a branch and its worktree look like: the tip, the status and the files' bytes.
const sourceOf = (root, branch, path) => [
  tipOf(root, `refs/heads/${branch}`),
  ...(path
    ? [git(path, "status", "--porcelain"), readFileSync(join(path, "three.txt"), "utf8")]
    : []),
];

// An agent's worktree on `worktree-agent-a1`: one commit to three.txt, an uncommitted edit and an
// untracked file.
function agentTree(r, { dirty = true, branch = "worktree-agent-a1" } = {}) {
  const path = join(r.root, ".claude", "worktrees", "agent-a1");
  git(r.root, "worktree", "add", "-q", "-b", branch, path, "main");
  const sha = commitFile(path, "three.txt", "a\nagent\nc\n", "feat: three by the agent");
  if (dirty) {
    writeFileSync(join(path, "three.txt"), "a\nagent\nc\nd\n");
    writeFileSync(join(path, "more.txt"), "more\n");
  }
  return { path, branch, sha };
}

// Nothing a refusal may write: no ledger, no run dir, no lane branch or worktree, the board as it was.
function assertNothingWritten(r, id, before) {
  assert.equal(existsSync(ledgerFile(r.root, id)), false, "no ledger");
  assert.equal(existsSync(join(processDir(r.root), "runs", id)), false, "no run dir");
  assert.equal(hasRef(r.root, `refs/heads/agentry/${id}`), false, "no lane branch");
  assert.equal(existsSync(join(r.root, ".agentry", "run", "worktrees", id)), false, "no worktree");
  assert.equal(board(r.root), before, "no board write");
}

test("adopt cuts the lane from main, picks the branch's commits and applies its worktree's uncommitted diff", () => {
  const r = repo();
  const src = agentTree(r);
  const main = tipOf(r.root, "HEAD");
  const res = lane(r, "adopt", "T1", "--branch", src.branch);
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual([res.json.step, res.json.next, res.json.state], ["adopt", "build", "building"]);
  const ledger = ledgerOf(r.root, "T1");
  assert.equal(ledger.base, main);
  assert.equal(ledger.branch, "agentry/T1");
  assert.deepEqual(
    {
      branch: ledger.adopted.branch,
      tip: ledger.adopted.tip,
      commits: ledger.adopted.commits,
      worktree: ledger.adopted.worktree,
      files: ledger.adopted.files,
      applied: ledger.adopted.applied,
    },
    {
      branch: src.branch,
      tip: src.sha,
      commits: [{ sha: src.sha, subject: "feat: three by the agent" }],
      worktree: src.path,
      files: 2,
      applied: true,
    },
  );
  // The lane: main, then the picked commit, then the diff applied staged.
  assert.equal(tipOf(r.root, "agentry/T1^"), main);
  assert.equal(git(r.root, "log", "-1", "--format=%s", "agentry/T1"), "feat: three by the agent");
  assert.equal(git(ledger.worktree, "status", "--porcelain"), "A  more.txt\nM  three.txt");
  assert.equal(readFileSync(join(ledger.worktree, "three.txt"), "utf8"), "a\nagent\nc\nd\n");
  // `start`'s board write and records.
  assert.match(board(r.root), /\| T1 +\| doing +\|/);
  assert.equal(ledger.mainAtStart.head, main);
  assert.ok(ledger.boardAtStart.paths.includes("plan/BOARD.md"));
  assert.match(
    res.json.cleanup,
    new RegExp(`git worktree remove ${src.path}; git branch -D ${src.branch}$`),
  );
});

test("adopt never moves, rewrites or deletes the branch or its worktree", () => {
  const r = repo();
  const src = agentTree(r);
  const before = sourceOf(r.root, src.branch, src.path);
  assert.equal(lane(r, "adopt", "T1", "--branch", src.branch).exit, 0);
  assert.deepEqual(sourceOf(r.root, src.branch, src.path), before);
  assert.equal(readFileSync(join(src.path, "more.txt"), "utf8"), "more\n");
});

test("the round-1 brief lists the adopted commits as already on the lane, not to redo", () => {
  const r = repo();
  const src = agentTree(r, { dirty: false });
  const res = lane(r, "adopt", "T1", "--branch", src.branch);
  assert.equal(res.exit, 0, res.stderr);
  const brief = readFileSync(res.json.brief, "utf8");
  assert.match(brief, /## Adopted work\n/);
  assert.ok(brief.includes(`\n- ${src.sha.slice(0, 7)} feat: three by the agent\n`), brief);
  assert.match(brief, /Its commits are already on the lane:/);
  assert.match(
    brief,
    /Check them against the contract, fix what the owner asked, and do not redo them\./,
  );
});

test("a branch with no worktree is adopted from its commits; the cleanup names the branch alone", () => {
  const r = repo();
  git(r.root, "branch", "feature-x", "main");
  const path = temp("adopt-hand-");
  git(r.root, "worktree", "add", "-q", path, "feature-x");
  const sha = commitFile(path, "three.txt", "a\nhand\nc\n", "feat: by hand");
  git(r.root, "worktree", "remove", path);
  const res = lane(r, "adopt", "T1", "--branch", "feature-x");
  assert.equal(res.exit, 0, res.stderr);
  const { adopted } = ledgerOf(r.root, "T1");
  assert.equal(adopted.worktree, null);
  assert.equal(adopted.files, 0);
  assert.equal(tipOf(r.root, "feature-x"), sha);
  assert.equal(res.json.cleanup.endsWith("git branch -D feature-x"), true, res.json.cleanup);
  assert.doesNotMatch(res.json.cleanup, /git worktree remove/);
});

test("adopted commits outside the contract's owns are a warning naming the owns --add line, never a refusal", () => {
  const r = repo();
  const src = agentTree(r, { dirty: false });
  commitFile(src.path, "docs/notes.md", "notes\n", "docs: notes");
  const res = lane(r, "adopt", "T1", "--branch", src.branch);
  assert.equal(res.exit, 0, res.stderr);
  assert.match(
    res.json.warning,
    /! adopted [0-9a-f]{7} docs: notes changes files outside owns: docs\/notes\.md/,
  );
  assert.match(res.json.warning, /exec owns T1 --root \S+ --add docs\/notes\.md --apply/);
  assert.doesNotMatch(res.json.warning, /feat: three by the agent/);
});

test("refused: a branch that does not exist, nothing written", () => {
  const r = repo();
  const before = board(r.root);
  const res = lane(r, "adopt", "T1", "--branch", "no-such-branch");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /no-such-branch does not exist/);
  assert.equal(res.stderr.trim().split("\n").length, 1);
  assertNothingWritten(r, "T1", before);
});

test("refused: nothing past main and a clean worktree (or none) is nothing to adopt", () => {
  const r = repo();
  const before = board(r.root);
  const path = join(r.root, ".claude", "worktrees", "agent-b2");
  git(r.root, "worktree", "add", "-q", "-b", "worktree-agent-b2", path, "main");
  const clean = lane(r, "adopt", "T1", "--branch", "worktree-agent-b2");
  assert.equal(clean.exit, 2);
  assert.match(clean.stderr, /nothing to adopt: use exec start/);
  git(r.root, "branch", "bare", "main");
  const bare = lane(r, "adopt", "T1", "--branch", "bare");
  assert.equal(bare.exit, 2);
  assert.match(bare.stderr, /nothing to adopt: use exec start/);
  assertNothingWritten(r, "T1", before);
  // Uncommitted work alone is something to adopt.
  writeFileSync(join(path, "more.txt"), "more\n");
  const dirty = lane(r, "adopt", "T1", "--branch", "worktree-agent-b2");
  assert.equal(dirty.exit, 0, dirty.stderr);
  assert.equal(readFileSync(join(dirty.json.worktree, "more.txt"), "utf8"), "more\n");
});

test("refused: a lane's own agentry/ branch points at restart --carry, nothing written", () => {
  const r = repo();
  git(r.root, "branch", "agentry/T9", "main");
  const before = board(r.root);
  const res = lane(r, "adopt", "T1", "--branch", "agentry/T9");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /agentry\/T9 is a lane's branch: use exec restart --carry/);
  assertNothingWritten(r, "T1", before);
});

test("refused: the branch's worktree mid-rebase or mid-merge, nothing written", () => {
  for (const op of ["rebase", "merge"]) {
    const r = repo();
    const src = agentTree(r, { dirty: false });
    commitFile(r.root, "three.txt", "a\nmain\nc\n", "fix: three on main");
    const stopped = spawnSync("git", ["-C", src.path, op, "main"], { env: gitEnv });
    assert.notEqual(stopped.status, 0, `the ${op} stops on its conflict`);
    const before = board(r.root);
    const res = lane(r, "adopt", "T1", "--branch", src.branch);
    assert.equal(res.exit, 2, res.stderr);
    assert.match(res.stderr, new RegExp(`the worktree of ${src.branch} \\(\\S+\\) is mid-${op}`));
    assertNothingWritten(r, "T1", before);
  }
});

test("refused: an open ledger for the id, as start refuses it", () => {
  const r = repo();
  assert.equal(lane(r, "start", "T1").exit, 0);
  const src = agentTree(r);
  const res = lane(r, "adopt", "T1", "--branch", src.branch);
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /a lane for T1 exists \(state building, next build\)/);
});

test("adopt without --branch is a usage error", () => {
  const r = repo();
  const res = lane(r, "adopt", "T1");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /adopt needs --branch <b>/);
});

test("a carried conflict stops like restart --carry: exit 1, the conflict named, a whole ledger, the source untouched", () => {
  const r = repo();
  const src = agentTree(r);
  commitFile(r.root, "three.txt", "a\nmain\nc\n", "fix: three on main");
  const before = sourceOf(r.root, src.branch, src.path);
  const res = lane(r, "adopt", "T1", "--branch", src.branch);
  assert.equal(res.exit, 1, res.stderr);
  assert.match(
    res.json.conflict,
    /^[0-9a-f]{7} feat: three by the agent conflicts in three\.txt: resolve it/,
  );
  const ledger = ledgerOf(r.root, "T1");
  assert.deepEqual([ledger.state, ledger.next, ledger.rounds.length], ["building", "build", 1]);
  assert.match(ledger.adopted.conflict, /conflicts in three\.txt/);
  assert.equal(ledger.adopted.applied, false);
  assert.equal(git(ledger.worktree, "diff", "--name-only", "--diff-filter=U"), "three.txt");
  const brief = readFileSync(res.json.brief, "utf8");
  assert.match(
    brief,
    /Resolve this first: [0-9a-f]{7} feat: three by the agent conflicts in three\.txt/,
  );
  assert.deepEqual(sourceOf(r.root, src.branch, src.path), before);
});

test("the adopted worktree is not counted against lanes.maxWriters, at the adopt or after it", () => {
  // One writer allowed: the worktree adopt takes in is the lane it cuts, not another writer.
  const r = repo({ config: { lanes: { maxWriters: 1 } } });
  const path = temp("adopt-elsewhere-");
  rmSync(path, { recursive: true });
  git(r.root, "worktree", "add", "-q", "-b", "feature-y", path, "main");
  commitFile(path, "three.txt", "a\ny\nc\n", "feat: y");
  const adopted = lane(r, "adopt", "T1", "--branch", "feature-y");
  assert.equal(adopted.exit, 0, adopted.stderr);
  // Two allowed: the adopted lane is one writer; its source worktree is not a second.
  writeFileSync(
    join(r.root, ".agentry", "config.json"),
    JSON.stringify({ lanes: { maxWriters: 2 } }),
  );
  const next = lane(r, "start", "T2");
  assert.equal(next.exit, 0, next.stderr);
  assert.ok(readdirSync(join(processDir(r.root), "ledger")).includes("T2.json"));
});
