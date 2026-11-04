// Tests for lib/process/git.mjs — the kit's only git I/O, against a throwaway repository.
// Run: node --test plugin/scripts/test/git.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import {
  branchTips,
  changedPaths,
  commitsOf,
  defaultBranch,
  graph,
  hasCommit,
  inEffect,
  knownCommits,
  log,
  octopusBase,
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

test("commitsOf: many refs in one call, each to its full commit; a missing ref, an option or a tree left out", () => {
  const tree = run("rev-parse", "HEAD^{tree}");
  const found = commitsOf(repo, ["main", sha.first.slice(0, 7), "0000000", "--all", tree]);
  assert.deepEqual(
    [...found],
    [
      ["main", sha.picked],
      [sha.first.slice(0, 7), sha.first],
    ],
  );
  assert.deepEqual([...commitsOf(outside, ["main"])], []);
});

test("branchTips: every branch's tip, or only those on a commit's history", () => {
  assert.deepEqual([...branchTips(repo)].sort(), [
    ["feature", sha.feature],
    ["main", sha.picked],
  ]);
  assert.deepEqual([...branchTips(repo, { on: sha.picked })], [["main", sha.picked]]);
  assert.deepEqual([...branchTips(repo, { on: "--all" })], []);
  assert.deepEqual([...branchTips(outside)], []);
});

test("graph, octopusBase: the commits since a common base, children first, with their parents", () => {
  const base = octopusBase(repo, [sha.picked, sha.feature]);
  assert.equal(base, sha.first);
  const found = graph(repo, ["main", "feature"], base);
  assert.deepEqual(
    [...found].sort(),
    [
      [sha.feature, [sha.first]],
      [sha.picked, [sha.second]],
      [sha.second, [sha.first]],
    ].sort(),
  );
  const order = [...found.keys()];
  assert.ok(order.indexOf(sha.picked) < order.indexOf(sha.second), "a child before its parent");
  assert.equal(octopusBase(outside, [sha.first]), null);
});

test("changedPaths: each pair's paths from its second commit to its first, in order, empty ones kept", () => {
  assert.deepEqual(
    changedPaths(repo, [
      [sha.feature, sha.first],
      [sha.second, sha.second],
      [sha.picked, sha.first],
    ]),
    [new Set(["b.txt"]), new Set(), new Set(["b.txt", "c.txt"])],
  );
  assert.deepEqual(changedPaths(repo, []), []);
  assert.equal(changedPaths(repo, [["main", sha.first]]), null, "full SHAs only");
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

// A throwaway history on main: `texts` is the file's content commit by commit; the SHAs, oldest first.
function history(file, texts) {
  const shas = [];
  for (const [i, text] of texts.entries()) shas.push(commit(file, text, `chore: ${file} ${i}`));
  return shas;
}

test("inEffect: an added line must still be there, wherever it moved, not a twin elsewhere", () => {
  const block = "p\nq\nX\nr\ns\n";
  const bare = "p\nq\nr\ns\n";
  const [base, task, moved, undone] = history("in-effect.txt", [
    `${block}-\n${bare}`,
    `${block}-\n${block}`,
    `top\n${block}-\n${block}`,
    `top\n${block}-\n${bare}`,
  ]);
  const change = { from: base, to: task };
  assert.equal(inEffect(repo, { ...change, onto: task }), null, "right where it landed");
  assert.equal(inEffect(repo, { ...change, onto: moved }), null, "moved down by a later line");
  assert.deepEqual(inEffect(repo, { ...change, onto: undone }), {
    file: "in-effect.txt",
    line: 9,
    what: "added",
  });
});

test("inEffect: a removed line must not be back at its place, though it may live elsewhere", () => {
  const block = "p\nq\nX\nr\ns\n";
  const bare = "p\nq\nr\ns\n";
  const [base, task, other, back] = history("removed.txt", [
    `${bare}-\n${block}`,
    `${bare}-\n${bare}`,
    `X\n${bare}-\n${bare}`,
    `X\n${bare}-\n${block}`,
  ]);
  const change = { from: base, to: task };
  assert.equal(inEffect(repo, { ...change, onto: other }), null, "X elsewhere is not X back");
  assert.equal(inEffect(repo, { ...change, onto: back })?.what, "removed");
});

test("inEffect: a whole file removed must stay removed; bad input is `git`, never a pass", () => {
  const [made] = history("gone.txt", ["a\nb\n"]);
  run("rm", "-q", "gone.txt");
  run("commit", "-q", "-m", "chore: remove gone.txt");
  const removed = run("rev-parse", "HEAD");
  const change = { from: made, to: removed };
  assert.equal(inEffect(repo, { ...change, onto: removed }), null);
  const [back] = history("gone.txt", ["b\n"]);
  assert.deepEqual(inEffect(repo, { ...change, onto: back }), {
    file: "gone.txt",
    line: 1,
    what: "removed",
  });
  assert.deepEqual(inEffect(repo, { ...change, onto: "main" }), { what: "git" }, "not a full SHA");
  assert.deepEqual(
    inEffect(repo, { from: made, to: back, onto: removed }),
    { what: "git" },
    "`to` is not on it",
  );
  assert.deepEqual(inEffect(outside, { ...change, onto: removed }), { what: "git" });
});

// Commit `file` with the executable bit set (`exec`) or cleared; returns the commit.
function chmodCommit(file, exec) {
  chmodSync(join(repo, file), exec ? 0o755 : 0o644);
  run("add", file);
  run("commit", "-q", "-m", `chore: chmod ${exec ? "+x" : "-x"} ${file}`);
  return run("rev-parse", "HEAD");
}

test("inEffect: a mode-only change holds while the mode does, though the content moved on", () => {
  const [base] = history("run.sh", ["echo hi\n"]);
  const task = chmodCommit("run.sh", true);
  const change = { from: base, to: task };
  const [edited] = history("run.sh", ["echo hi\necho more\n"]);
  assert.equal(inEffect(repo, { ...change, onto: edited }), null, "still executable");
  const reverted = chmodCommit("run.sh", false);
  assert.deepEqual(inEffect(repo, { ...change, onto: reverted }), {
    file: "run.sh",
    what: "file",
  });
});

test("inEffect: a mode taken back on the same content is not in effect", () => {
  const [base] = history("tool.sh", ["a\n"]);
  writeFileSync(join(repo, "tool.sh"), "a\nb\n");
  const task = chmodCommit("tool.sh", true); // a line and the executable bit, in one commit
  const reverted = chmodCommit("tool.sh", false); // same blob as `task`, mode back
  assert.deepEqual(inEffect(repo, { from: base, to: task, onto: reverted }), {
    file: "tool.sh",
    what: "file",
  });
});

test("inEffect: a file turned into a symlink with the same bytes is not as it landed", () => {
  const [base, task] = history("link.txt", ["old", "target"]);
  run("rm", "-q", "link.txt");
  symlinkSync("target", join(repo, "link.txt"));
  run("add", "link.txt");
  run("commit", "-q", "-m", "chore: link.txt is a symlink now");
  const linked = run("rev-parse", "HEAD");
  assert.equal(run("rev-parse", `${task}:link.txt`), run("rev-parse", `${linked}:link.txt`));
  assert.deepEqual(inEffect(repo, { from: base, to: task, onto: linked }), {
    file: "link.txt",
    what: "file",
  });
});

test("inEffect: a removed block put back elsewhere in the file is not in effect", () => {
  const body = "function f() {\n  return 1;\n}\n";
  const [base, task, moved] = history("block.js", [
    `a\n${body}b\nc\n`,
    "a\nb\nc\n",
    `a\nb\nc\n${body}`,
  ]);
  assert.deepEqual(inEffect(repo, { from: base, to: task, onto: moved }), {
    file: "block.js",
    line: 1,
    what: "removed",
  });
  // Punctuation alone says nothing: braces closing elsewhere are not the removed ones back.
  const [braced, cut, more] = history("braces.js", ["a\n}\n}\nb\n", "a\nb\n", "a\nb\n}\n}\n"]);
  assert.equal(inEffect(repo, { from: braced, to: cut, onto: more }), null);
});

test("inEffect: a single specific removed line put back is not in effect; a generic one is not a signal", () => {
  const line = "enableBackdoor(true);";
  const [base, task, moved] = history("one.js", [
    `a = 1;\n${line}\nb = 2;\n`,
    "a = 1;\nb = 2;\n",
    `a = 1;\nb = 2;\n${line}\n`,
  ]);
  assert.deepEqual(inEffect(repo, { from: base, to: task, onto: moved }), {
    file: "one.js",
    line: 1,
    what: "removed",
  });
  const [braced, cut, more] = history("one-brace.js", ["a\n}\nb\n", "a\nb\n", "a\nb\n}\n"]);
  assert.equal(inEffect(repo, { from: braced, to: cut, onto: more }), null);
});

test("inEffect: the mode a created file landed with must still hold", () => {
  writeFileSync(join(repo, "new.sh"), "echo new\n");
  const base = run("rev-parse", "HEAD");
  const task = chmodCommit("new.sh", true); // created executable
  const reverted = chmodCommit("new.sh", false);
  assert.deepEqual(inEffect(repo, { from: base, to: task, onto: reverted }), {
    file: "new.sh",
    what: "file",
  });
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

// ---- no git call hangs: no stdin, a timeout, no child left behind ----

// Is process `pid` gone? A killed orphan is reaped by init a moment later, so look for up to 3 s.
function goneWithin3s(pid) {
  for (const end = Date.now() + 3000; Date.now() < end; ) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    spawnSync("sleep", ["0.1"]);
  }
  return false;
}

// Run `body` with a fake `git` first on PATH: `script` is its /bin/sh body, with $LOG naming a file in `dir`.
function withFakeGit(script, body) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentry-fakegit-")));
  writeFileSync(join(dir, "git"), `#!/bin/sh\nLOG="${dir}/log"\n${script}\n`);
  chmodSync(join(dir, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  try {
    return body(dir);
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
// A stdin of `ignore` is /dev/null, a character device; one the parent writes to is a pipe or socket.
const stdinKind = '[ -c /dev/stdin ] && echo "$1 none" >> "$LOG" || echo "$1 open" >> "$LOG"';

test("git calls get no stdin unless they pass input", () => {
  withFakeGit(`${stdinKind.replace(/\$1/g, "$3")}; cat > /dev/null`, (dir) => {
    trackedFiles(dir, "*.md"); // no input
    knownCommits(dir, ["abcd1234"]); // passes input
    const seen = readFileSync(join(dir, "log"), "utf8").trim().split("\n");
    assert.deepEqual(seen, ["ls-files none", "cat-file open"]);
  });
});

test("reverseApplies hands git the patch as a file with no stdin", () => {
  const script = `
case "$3" in
  rev-parse) echo "$2"; exit 0 ;;
  diff) echo patch; exit 0 ;;
  apply) ${stdinKind.replace(/\$1/g, "apply")}; echo "$@" >> "$LOG"; exit 0 ;;
esac
exit 0`;
  withFakeGit(script, (dir) => {
    const change = { from: "main", to: "feature", onto: "main" };
    assert.equal(reverseApplies(dir, change), true);
    const [kind, args] = readFileSync(join(dir, "log"), "utf8").trim().split("\n");
    assert.equal(kind, "apply none");
    assert.match(args, /apply --cached --check -R \S+change\.patch$/);
  });
});

test("a 5 MB patch still reverse-applies", () => {
  const big = join(realpathSync(mkdtempSync(join(tmpdir(), "agentry-big-"))), "r");
  mkdirSync(big);
  const g = (...a) => {
    const res = spawnSync("git", ["-C", big, ...a], { encoding: "utf8", env });
    assert.equal(res.status, 0, res.stderr);
  };
  try {
    g("init", "-q", "-b", "main");
    writeFileSync(join(big, "f.txt"), "start\n");
    g("add", ".");
    g("commit", "-q", "-m", "a");
    const from = spawnSync("git", ["-C", big, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(join(big, "f.txt"), "line of text to fill a patch\n".repeat(180_000));
    g("commit", "-q", "-am", "b");
    assert.ok(readFileSync(join(big, "f.txt")).length > 5_000_000);
    assert.equal(reverseApplies(big, { from, to: "HEAD", onto: "HEAD" }), true);
  } finally {
    rmSync(join(big, ".."), { recursive: true, force: true });
  }
});

test("a git call that outlives the timeout is killed, answers null and leaves no child", () => {
  const script = 'echo $$ > "$LOG"; sleep 60 & echo $! > "$LOG.child"; wait';
  withFakeGit(script, (dir) => {
    process.env.AGENTRY_GIT_TIMEOUT_MS = "1500";
    try {
      const started = Date.now();
      assert.equal(trackedFiles(dir, "*.md"), null);
      assert.ok(Date.now() - started < 10_000, "returned long before the sleep ended");
    } finally {
      process.env.AGENTRY_GIT_TIMEOUT_MS = ""; // unset: the default applies
    }
    for (const file of ["log", "log.child"]) {
      const pid = Number(readFileSync(join(dir, file), "utf8"));
      assert.ok(pid > 0);
      assert.ok(goneWithin3s(pid), `${file}: process ${pid} is gone`);
    }
  });
});

test("a git call slower than a moment but inside the timeout still succeeds", () => {
  withFakeGit("sleep 2; printf 'a.md\\0'", (dir) => {
    assert.deepEqual(trackedFiles(dir, "*.md"), ["a.md"]);
  });
});

test("a timed-out git makes reverseApplies false, as for any git error", () => {
  withFakeGit('case "$3" in rev-parse) echo "$2" ;; *) sleep 60 ;; esac', (dir) => {
    process.env.AGENTRY_GIT_TIMEOUT_MS = "1500";
    try {
      assert.equal(reverseApplies(dir, { from: "a", to: "b", onto: "c" }), false);
    } finally {
      process.env.AGENTRY_GIT_TIMEOUT_MS = ""; // unset: the default applies
    }
  });
});

test("the plugin test runner gives a hung test 180 s, not forever", () => {
  const runner = readFileSync(
    new URL("../../../scripts/run-plugin-tests.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /"--test-timeout=180000"/);
});

test("a zero, negative or junk AGENTRY_GIT_TIMEOUT_MS falls back to the default, not to failure", () => {
  withFakeGit("printf 'a.md\\0'", (dir) => {
    try {
      for (const bad of ["-5", "0", "abc"]) {
        process.env.AGENTRY_GIT_TIMEOUT_MS = bad;
        assert.deepEqual(trackedFiles(dir, "*.md"), ["a.md"], `"${bad}"`);
      }
    } finally {
      process.env.AGENTRY_GIT_TIMEOUT_MS = ""; // unset: the default applies
    }
  });
});
