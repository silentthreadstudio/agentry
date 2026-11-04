// Tests for `lane spike` (field 87) on temp git repos: an agent worktree filed by its branch or its path in
// `.agentry/run/spikes.json` as work for a board item (`--for`) or kept on purpose (`--keep`), dropped with
// `--forget`, listed with no flag (a gone branch shown as `gone`); the refusals write nothing; the file is
// written whole, so a torn write never leaves a part of it.
// Run: node --test plugin/scripts/test/spike-cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fileSpike } from "../lib/lane/spikes.mjs";
import { boardRepo, handBranch, ledger } from "./drift-repo.mjs";
import { git, gitEnv } from "./git-repo.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});
function fresh() {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  return repo;
}
function spike(root, ...args) {
  const res = spawnSync("node", [LANE, "spike", ...args, "--root", root], {
    encoding: "utf8",
    env: gitEnv,
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* text or a refusal */
  }
  return { exit: res.status, json, stdout: res.stdout, stderr: res.stderr };
}
const file = (root) => join(root, ".agentry", "run", "spikes.json");
const filed = (root) => JSON.parse(readFileSync(file(root), "utf8"));
const agent = (root, name = "a1") =>
  handBranch(root, `.claude/worktrees/agent-${name}`, `worktree-agent-${name}`);

test("--for <id> files the worktree by its branch as work for that board item", () => {
  const { root } = fresh();
  const tree = agent(root);
  const res = spike(root, tree.branch, "--for", "T2", "--json");
  assert.equal(res.exit, 0, res.stderr);
  const [entry] = filed(root);
  assert.deepEqual(
    { branch: entry.branch, path: entry.path, for: entry.for },
    { branch: tree.branch, path: tree.path, for: "T2" },
  );
  assert.match(entry.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(entry.keep, undefined);
  assert.deepEqual(res.json.filed, entry);
});

test("a worktree is filed by its path too, and filing it again replaces its entry", () => {
  const { root } = fresh();
  const tree = agent(root);
  assert.equal(spike(root, tree.path, "--for", "t1").exit, 0);
  assert.equal(filed(root)[0].for, "T1", "the id is read in any case");
  assert.equal(spike(root, tree.branch, "--keep", "a probe for later").exit, 0);
  assert.deepEqual(
    filed(root).map((s) => [s.branch, s.for, s.keep]),
    [[tree.branch, undefined, "a probe for later"]],
  );
});

test("--keep files it as kept on purpose, with the reason", () => {
  const { root } = fresh();
  const tree = agent(root);
  const res = spike(root, tree.branch, "--keep", "the benchmark rig");
  assert.equal(res.exit, 0, res.stderr);
  assert.match(res.stdout, /^filed worktree-agent-a1 kept: "the benchmark rig"/);
  assert.deepEqual(
    filed(root).map((s) => [s.branch, s.keep]),
    [[tree.branch, "the benchmark rig"]],
  );
});

test("--forget drops the entry, by branch or path, and refuses one that is not filed", () => {
  const { root } = fresh();
  const a = agent(root, "a1");
  const b = agent(root, "b2");
  spike(root, a.branch, "--for", "T1");
  spike(root, b.branch, "--for", "T2");
  assert.equal(spike(root, a.path, "--forget").exit, 0);
  assert.deepEqual(
    filed(root).map((s) => s.branch),
    [b.branch],
  );
  const again = spike(root, a.branch, "--forget");
  assert.equal(again.exit, 2);
  assert.match(again.stderr, /no spike is filed by that branch or path/);
});

test("no flag lists the filed spikes, a branch gone since shown as gone", () => {
  const { root } = fresh();
  const a = agent(root, "a1");
  const b = agent(root, "b2");
  spike(root, a.branch, "--for", "T1");
  spike(root, b.branch, "--keep", "kept");
  git(root, "worktree", "remove", "--force", b.path);
  git(root, "branch", "-D", b.branch);
  const text = spike(root);
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, /^ {2}worktree-agent-a1 · for T1 · \S+agent-a1$/m);
  assert.match(text.stdout, /^ {2}worktree-agent-b2 · kept: "kept" · \S+agent-b2 · gone$/m);
  const json = spike(root, "--json").json;
  assert.deepEqual(
    json.spikes.map((s) => [s.branch, s.gone]),
    [
      [a.branch, false],
      [b.branch, true],
    ],
  );
  assert.match(spike(fresh().root).stdout, /none filed/);
});

test("refused, nothing written: an unknown branch or path, the main checkout, a branch a ledger tracks", () => {
  const { root } = fresh();
  git(root, "worktree", "add", "-q", "-b", "agentry/T2", join(root, "lane-t2"), "main");
  ledger(root, "T2");
  const adopted = agent(root, "c3");
  ledger(root, "T3", {
    adopted: { branch: adopted.branch, tip: adopted.sha, commits: [], worktree: adopted.path },
  });
  const cases = [
    ["no-such-branch", /that is no branch and no path/],
    [join(root, "nowhere"), /that is no branch and no path/],
    ["main~0", /that is no branch and no path/],
    [root, /that is the main checkout/],
    ["agentry/T2", /agentry\/T2 is T2's lane: its ledger tracks it/],
    [adopted.branch, /worktree-agent-c3 is T3's lane: its ledger tracks it/],
  ];
  for (const [target, why] of cases) {
    const res = spike(root, target, "--for", "T1");
    assert.equal(res.exit, 2, target);
    assert.match(res.stderr, why);
  }
  assert.equal(existsSync(file(root)), false);
});

test("a ledgerless agentry/ worktree is filed like any other", () => {
  const { root } = fresh();
  const path = join(root, ".agentry", "run", "worktrees", "T2");
  git(root, "worktree", "add", "-q", "-b", "agentry/T2", path, "main");
  const res = spike(root, "agentry/T2", "--for", "T2");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual(
    filed(root).map((s) => [s.branch, s.for]),
    [["agentry/T2", "T2"]],
  );
});

test("refused, nothing written: an id the board does not hold, and --for with --keep", () => {
  const { root } = fresh();
  const tree = agent(root);
  const unknown = spike(root, tree.branch, "--for", "T99");
  assert.equal(unknown.exit, 2);
  assert.match(unknown.stderr, /--for T99: the board holds no such item/);
  const both = spike(root, tree.branch, "--for", "T1", "--keep", "why");
  assert.equal(both.exit, 2);
  assert.match(both.stderr, /--for and --keep go one at a time/);
  assert.equal(existsSync(file(root)), false);
});

test("spikes.json survives a torn write: a writer killed mid-write leaves the old list whole", () => {
  const { root } = fresh();
  const tree = agent(root);
  spike(root, tree.branch, "--for", "T1");
  const before = readFileSync(file(root), "utf8");
  // What a writer killed between its write and its rename leaves: its temp file, half written.
  const torn = `${file(root)}.agentry-99999999.tmp`;
  writeFileSync(torn, before.slice(0, before.length / 2));
  const listed = spike(root, "--json");
  assert.equal(listed.exit, 0, listed.stderr);
  assert.deepEqual(
    listed.json.spikes.map((s) => s.branch),
    [tree.branch],
  );
  assert.equal(readFileSync(file(root), "utf8"), before);
  // A write is whole too: this writer's own temp never outlives it.
  assert.equal(spike(root, tree.branch, "--keep", "later").exit, 0);
  assert.deepEqual(
    readdirSync(dirname(file(root))).filter(
      (n) => n.startsWith("spikes.json.") && n !== basename(torn),
    ),
    [],
  );
  assert.equal(filed(root)[0].keep, "later");
});

test("a spikes.json that is not a list of entries is refused, never overwritten", () => {
  const { root } = fresh();
  const tree = agent(root);
  spike(root, tree.branch, "--for", "T1");
  writeFileSync(file(root), '[{"branch": "x"');
  const res = spike(root, tree.branch, "--keep", "why");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /spikes\.json is not a list of \{ branch, path \} entries/);
  assert.equal(readFileSync(file(root), "utf8"), '[{"branch": "x"');
});

test("a revision of a filed worktree's branch (b~0, b@{0}) is no branch: refused, nothing written", () => {
  const { root } = fresh();
  const tree = agent(root);
  for (const rev of [`${tree.branch}~0`, `${tree.branch}@{0}`, `${tree.branch}^{commit}`]) {
    const res = spike(root, rev, "--for", "T1");
    assert.equal(res.exit, 2, rev);
    assert.match(res.stderr, /that is no branch and no path/);
  }
  assert.equal(existsSync(file(root)), false);
});

test("a worktree on a spelling no branch is named is refused by its path or its branch, nothing written", () => {
  const { root } = fresh();
  const tree = agent(root);
  // What `git checkout WORKTREE-AGENT-A1` writes on a case-insensitive filesystem, on any filesystem.
  git(tree.path, "symbolic-ref", "HEAD", "refs/heads/WORKTREE-AGENT-A1");
  for (const target of [tree.path, tree.branch]) {
    const res = spike(root, target, "--keep", "why");
    assert.equal(res.exit, 2, target);
    assert.ok(
      res.stderr.includes(
        `${tree.path} is on WORKTREE-AGENT-A1, which no branch is named: check it out by its exact name`,
      ),
      res.stderr,
    );
  }
  assert.equal(existsSync(file(root)), false);
});

test("a branch with a case twin, or a name holding a control character, is refused on one line", () => {
  const { root } = fresh();
  const tree = agent(root);
  git(root, "pack-refs", "--all");
  git(root, "branch", "WORKTREE-AGENT-A1", "main");
  const twin = spike(root, tree.branch, "--keep", "why");
  assert.equal(twin.exit, 2);
  assert.match(
    twin.stderr,
    /worktree-agent-a1 has a case twin WORKTREE-AGENT-A1: rename one first/,
  );
  const control = spike(root, `${tree.branch}\n`, "--keep", "why");
  assert.equal(control.exit, 2);
  assert.equal(control.stderr.trim().split("\n").length, 1, control.stderr);
  assert.ok(control.stderr.includes(JSON.stringify(`${tree.branch}\n`)), control.stderr);
  assert.equal(existsSync(file(root)), false);
});

test("by its path, a worktree's branch with a case twin is refused as by its name, nothing written", () => {
  const { root } = fresh();
  const tree = agent(root);
  git(root, "pack-refs", "--all");
  git(root, "branch", "WORKTREE-AGENT-A1", "main");
  for (const target of [tree.path, tree.branch]) {
    const res = spike(root, target, "--keep", "why");
    assert.equal(res.exit, 2, target);
    assert.match(
      res.stderr,
      /worktree-agent-a1 has a case twin WORKTREE-AGENT-A1: rename one first/,
    );
  }
  assert.equal(existsSync(file(root)), false);
});

test("a worktree on a branch with no commits yet says so, by its path or its branch, nothing written", () => {
  const { root } = fresh();
  const path = join(root, ".claude", "worktrees", "agent-z");
  mkdirSync(dirname(path), { recursive: true });
  git(root, "worktree", "add", "-q", "--detach", path, "main");
  git(path, "symbolic-ref", "HEAD", "refs/heads/worktree-agent-z");
  for (const target of [path, "worktree-agent-z"]) {
    const res = spike(root, target, "--keep", "why");
    assert.equal(res.exit, 2, target);
    assert.match(res.stderr, /worktree-agent-z has no commits yet/);
    assert.doesNotMatch(res.stderr, /check it out by its exact name|no branch and no path/);
  }
  assert.equal(existsSync(file(root)), false);
});

test("--for is echoed on one line, a --keep reason with a control character is refused, nothing written", () => {
  const { root } = fresh();
  const tree = agent(root);
  const unknown = spike(root, tree.branch, "--for", "T\n9");
  assert.equal(unknown.exit, 2);
  assert.equal(unknown.stderr.trim().split("\n").length, 1, unknown.stderr);
  assert.ok(
    unknown.stderr.includes(`--for ${JSON.stringify("T\n9")}: the board holds no such item`),
  );
  for (const why of ["why\nnot", "a\tb", "x\u001b[2J"]) {
    const res = spike(root, tree.branch, "--keep", why);
    assert.equal(res.exit, 2, JSON.stringify(why));
    assert.equal(res.stderr.trim().split("\n").length, 1, res.stderr);
    assert.match(res.stderr, /--keep takes a one-line reason/);
  }
  assert.equal(existsSync(file(root)), false);
});

test("a spike filed with a multi-line reason or id before this check is listed on one line", () => {
  const { root } = fresh();
  const a = agent(root, "a1");
  const b = agent(root, "b2");
  fileSpike(root, { branch: a.branch, path: a.path, keep: "why\nnot", at: "2026-01-01T00:00:00Z" });
  fileSpike(root, { branch: b.branch, path: b.path, for: "T\n1", at: "2026-01-01T00:00:00Z" });
  const text = spike(root);
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, /^ {2}worktree-agent-a1 · kept: "why\\nnot" · \S+agent-a1$/m);
  assert.match(text.stdout, /^ {2}worktree-agent-b2 · for "T\\n1" · \S+agent-b2$/m);
  assert.equal(text.stdout.trim().split("\n").length, 3, text.stdout);
});

test("a spikes.json write that throws is a one-line refusal at exit 2, never a stack trace", () => {
  const { root } = fresh();
  const a = agent(root, "a1");
  const b = agent(root, "b2");
  assert.equal(spike(root, a.branch, "--for", "T1").exit, 0);
  const before = readFileSync(file(root), "utf8");
  // The file reads, but the write's temp file cannot be made beside it: fileSpike and forgetSpike throw.
  chmodSync(dirname(file(root)), 0o555);
  try {
    for (const args of [
      [b.branch, "--keep", "why"],
      [a.branch, "--forget"],
    ]) {
      const res = spike(root, ...args);
      assert.equal(res.exit, 2, res.stderr);
      assert.equal(res.stderr.trim().split("\n").length, 1, res.stderr);
      assert.match(res.stderr, /^✗ lane spike /);
      assert.doesNotMatch(res.stderr, /\bat \S+\.mjs:\d+/);
    }
  } finally {
    chmodSync(dirname(file(root)), 0o755);
  }
  assert.equal(readFileSync(file(root), "utf8"), before);
});
