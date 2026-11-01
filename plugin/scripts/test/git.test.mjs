// Tests for lib/process/git.mjs — the kit's only git I/O, against a throwaway repository.
// Run: node --test plugin/scripts/test/git.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  defaultBranch,
  hasCommit,
  knownCommits,
  log,
  patchIds,
  reverseApplies,
  trackedFiles,
  worktrees,
} from "../lib/process/git.mjs";

let repo;
let outside;
const sha = {};

// The developer's own git config (hooks, signing, templates) must not leak into the fixture repo.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
function run(...args) {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}
function commit(file, text, subject) {
  writeFileSync(join(repo, file), text);
  run("add", file);
  run("commit", "-q", "-m", subject);
  return run("rev-parse", "HEAD");
}

before(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agentry-git-")));
  repo = join(base, "repo");
  outside = join(base, "not-a-repo");
  mkdirSync(repo);
  mkdirSync(outside);
  run("init", "-q", "-b", "main");
  sha.first = commit("a.txt", "one\n", "feat: first");
  run("switch", "-q", "-c", "feature");
  sha.feature = commit("b.txt", "two\n", "feat: on the branch");
  run("switch", "-q", "main");
  sha.second = commit("c.txt", "three\n", "feat: second");
  run("cherry-pick", "-x", sha.feature);
  sha.picked = run("rev-parse", "HEAD");
  run("worktree", "add", "-q", join(base, "wt"), "feature");
});
after(() => rmSync(join(repo, ".."), { recursive: true, force: true }));

test("hasCommit: a real commit, short or full; not a missing one or an option", () => {
  assert.equal(hasCommit(repo, sha.first), true);
  assert.equal(hasCommit(repo, sha.first.slice(0, 7)), true);
  assert.equal(hasCommit(repo, "0000000"), false);
  assert.equal(hasCommit(repo, "--all"), false);
  assert.equal(hasCommit(outside, sha.first), false);
});

test("knownCommits: one call answers many SHAs, short or full, and hasCommit agrees", () => {
  const tree = run("rev-parse", "HEAD^{tree}");
  const asked = [sha.first, sha.second.slice(0, 8), "0000000", tree, "--all", sha.picked];
  const found = knownCommits(repo, asked);
  assert.deepEqual([...found].sort(), [sha.first, sha.second.slice(0, 8), sha.picked].sort());
  assert.deepEqual(
    asked.map((s) => hasCommit(repo, s)),
    [true, true, false, false, false, true],
    "a tree is not a commit; an option never reaches git",
  );
  assert.deepEqual([...knownCommits(outside, [sha.first])], []);
  assert.deepEqual([...knownCommits(repo, [])], []);
});

test("trackedFiles: the tracked files a glob matches, untracked ones left out; null outside a repo", () => {
  writeFileSync(join(repo, "untracked.txt"), "loose\n");
  try {
    assert.deepEqual(trackedFiles(repo, "**/*.txt"), ["a.txt", "b.txt", "c.txt"]);
    assert.deepEqual(trackedFiles(repo, "**/*.md"), []);
    assert.equal(trackedFiles(outside, "**/*.txt"), null);
  } finally {
    rmSync(join(repo, "untracked.txt"));
  }
});

test("log: newest first, with subjects, limited to n", () => {
  assert.deepEqual(
    log(repo, { n: 2 }).map((c) => c.subject),
    ["feat: on the branch", "feat: second"],
  );
  assert.equal(log(repo, { n: 10 }).length, 3);
  assert.equal(log(repo, { ref: "feature", n: 1 })[0].sha, sha.feature);
  assert.deepEqual(log(repo, { ref: "--all" }), [], "a ref may not be an option");
  assert.deepEqual(log(outside), []);
});

test("patchIds: a cherry-picked commit has its original's patch id", () => {
  const [onBranch] = patchIds(repo, "main..feature");
  const [onMain] = patchIds(repo, `${sha.second}..main`);
  assert.equal(onBranch.sha, sha.feature);
  assert.equal(onMain.sha, sha.picked);
  assert.equal(onBranch.patchId, onMain.patchId);
  assert.deepEqual(patchIds(outside, "main..feature"), []);
});

test("reverseApplies: a change is in a tree only while all its lines are; the repo is untouched", () => {
  const change = { from: sha.first, to: sha.feature };
  const deep = join(repo, "deep");
  mkdirSync(deep, { recursive: true });
  assert.equal(reverseApplies(repo, { ...change, onto: "main" }), true, "picked onto main");
  assert.equal(reverseApplies(repo, { ...change, onto: sha.second }), false, "not there yet");
  assert.equal(
    reverseApplies(deep, { ...change, onto: sha.second }),
    false,
    "from a subfolder the whole change is still checked",
  );
  assert.equal(reverseApplies(repo, { from: sha.first, to: sha.first, onto: "main" }), false);
  assert.equal(reverseApplies(repo, { ...change, onto: "--all" }), false);
  assert.equal(reverseApplies(outside, { ...change, onto: "main" }), false);
  assert.equal(run("status", "--porcelain"), "");
});

test("worktrees: each path with its head and branch", () => {
  const trees = worktrees(repo);
  assert.deepEqual(
    trees.map((t) => [t.path, t.branch]),
    [
      [repo, "main"],
      [join(repo, "..", "wt"), "feature"],
    ],
  );
  assert.equal(trees[1].head, sha.feature);
  assert.deepEqual(worktrees(outside), []);
});

test("defaultBranch: a local main without a remote; null outside a repo", () => {
  assert.equal(defaultBranch(repo), "main");
  assert.equal(defaultBranch(outside), null);
});
