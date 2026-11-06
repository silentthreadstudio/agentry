// Tests for the commit subjects `lane exec report` names when they are over the repo's limit
// (`commits.subjectMax`, else 72), with the line that rewords each, and the limit every build brief prints.
// A builder is simulated by committing in the worktree and writing its report file.
// Run: node --test plugin/scripts/test/exec-rewords.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { rewordLine } from "../lib/lane/exec/rewords.mjs";
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
  name: "Rewords",
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
const BOARD_MD = `# Rewords

## Tasks

| Task | Status | Verdict |
| ---- | ------ | ------- |
| T1   | todo   |         |
`;
const TASKS_MD = `# Tasks

### T1 · One

- **Owns:** \`one.txt\`, \`two.txt\`, \`three.txt\`. Accept: one.txt exists.
`;

function repo(extra = {}) {
  const root = temp("rewords-repo-");
  const home = temp("rewords-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  writeSpec(join(root, ".agentry"), { ...SPEC, ...extra });
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  return { root, home };
}
function lane(r, ...args) {
  const res = spawnSync("node", [LANE, "exec", ...args, "--json", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* a refusal on stderr */
  }
  return { exit: res.status, json, stderr: res.stderr };
}
const subjectsOf = (dir) => git(dir, "log", "--reverse", "--format=%s", "main..HEAD").split("\n");
const LONG = `feat: ${"x".repeat(80)}`;
const run = (line) =>
  spawnSync("sh", ["-c", line], { encoding: "utf8", env: { ...process.env, ...gitEnv } });

test("with no commits rules, report names a subject over 72 with its line, and the lane goes on", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  assert.match(
    readFileSync(out.brief, "utf8"),
    /- Keep every commit subject within 72 characters: a longer one is named when you report, with the line that rewords it\./,
  );
  commitFile(out.worktree, "one.txt", "1\n", LONG);
  writeFileSync(out.reportPath, "DONE\nadded one.txt\nused_memories: none\n");
  const sha = git(out.worktree, "rev-parse", "HEAD");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify", "no rule, no refusal");
  assert.equal(
    res.json.rewords,
    `run in this order, newest first:\ncommit ${sha.slice(0, 7)} "${LONG}" is 86 chars, over the 72 limit → ${rewordLine({ worktree: out.worktree, branch: "agentry/T1", sha, tip: sha, limit: 72 })}`,
  );
});

test("a subject at commits.subjectMax is not named, and the build brief prints that limit", () => {
  const r = repo({ commits: { subjectMax: 30 } });
  const out = lane(r, "start", "T1").json;
  assert.match(readFileSync(out.brief, "utf8"), /within 30 characters/);
  commitFile(out.worktree, "one.txt", "1\n", `feat: ${"x".repeat(24)}`); // 30 chars
  writeFileSync(out.reportPath, "DONE\nok\nused_memories: none\n");
  const ok = lane(r, "report", "T1");
  assert.equal(ok.json.rewords, undefined);
  assert.equal(ok.json.next, "verify");
});

test("with commits.subjectMax set the refused report's fix brief carries the lines that reword", () => {
  const r = repo({ commits: { subjectMax: 30 } });
  const out = lane(r, "start", "T1").json;
  const long = `feat: ${"y".repeat(40)}`;
  commitFile(out.worktree, "one.txt", "1\n", long);
  commitFile(out.worktree, "two.txt", "2\n", "feat: add two.txt");
  writeFileSync(out.reportPath, "DONE\nok\nused_memories: none\n");
  const sha = git(out.worktree, "rev-parse", "HEAD~1");
  const res = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "fix");
  const line = rewordLine({
    worktree: out.worktree,
    branch: "agentry/T1",
    sha,
    tip: git(out.worktree, "rev-parse", "HEAD"),
    limit: 30,
  });
  const expected = `run in this order, newest first:\ncommit ${sha.slice(0, 7)} "${long}" is 46 chars, over the 30 limit → ${line}`;
  assert.equal(res.json.rewords, expected);
  const brief = readFileSync(res.json.brief, "utf8");
  assert.ok(brief.includes("## Subjects to reword\n\n"), brief);
  assert.ok(brief.includes(`${expected}\n`), brief);
  assert.match(brief, /within 30 characters/);
});

test("the line for the tip amends it; the line for an earlier commit rewords it and replays the rest", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  const wt = out.worktree;
  commitFile(wt, "one.txt", "1\n", "feat: add one.txt");
  commitFile(wt, "two.txt", "2\n", LONG);
  commitFile(wt, "three.txt", "3\n", "feat: add three.txt");
  const mid = git(wt, "rev-parse", "HEAD~1");
  const tree = git(wt, "rev-parse", "HEAD^{tree}");
  // An earlier commit: the replay keeps the commits after it and the tree.
  const fixMid = rewordLine({
    worktree: wt,
    branch: "agentry/T1",
    sha: mid,
    tip: git(wt, "rev-parse", "HEAD"),
    limit: 72,
  });
  const res = run(fixMid.replace("<new subject, at most 72 characters>", "feat: add two.txt"));
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(subjectsOf(wt), [
    "feat: add one.txt",
    "feat: add two.txt",
    "feat: add three.txt",
  ]);
  assert.equal(git(wt, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "agentry/T1", "back on the branch");
  assert.equal(git(wt, "status", "--porcelain"), "");
  // The tip.
  commitFile(wt, "four.txt", "4\n", LONG);
  const fixTip = rewordLine({
    worktree: wt,
    branch: "agentry/T1",
    sha: git(wt, "rev-parse", "HEAD"),
    tip: git(wt, "rev-parse", "HEAD"),
    limit: 72,
  });
  assert.equal(
    run(fixTip.replace("<new subject, at most 72 characters>", "feat: add four.txt")).status,
    0,
  );
  assert.equal(subjectsOf(wt).at(-1), "feat: add four.txt");
});

test("two earlier commits and the tip over the limit: the printed lines, run in order, fix every subject", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  const wt = out.worktree;
  commitFile(wt, "one.txt", "1\n", `feat: ${"a".repeat(80)}`);
  commitFile(wt, "two.txt", "2\n", "feat: add two.txt");
  commitFile(wt, "three.txt", "3\n", `feat: ${"b".repeat(80)}`);
  commitFile(wt, "four.txt", "4\n", `feat: ${"c".repeat(80)}`);
  writeFileSync(out.reportPath, "DONE\nok\nused_memories: none\n");
  const tree = git(wt, "rev-parse", "HEAD^{tree}");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  const [head, ...lines] = res.json.rewords.split("\n");
  assert.equal(head, "run in this order, newest first:");
  assert.equal(lines.length, 3);
  // Newest first: the tip's amend comes first.
  assert.match(lines[0], /^commit \w{7} "feat: c+" .* → cd .* && git commit --amend -m /);
  assert.match(lines[1], /"feat: b+"/);
  assert.match(lines[2], /"feat: a+"/);
  const names = ["feat: add four.txt", "feat: add three.txt", "feat: add one.txt"];
  lines.forEach((line, i) => {
    const cmd = line.slice(line.indexOf(" → ") + 3).replace(/<new subject[^>]*>/, names[i]);
    const done = run(cmd);
    assert.equal(done.status, 0, done.stderr);
  });
  assert.deepEqual(subjectsOf(wt), [
    "feat: add one.txt",
    "feat: add two.txt",
    "feat: add three.txt",
    "feat: add four.txt",
  ]);
  assert.equal(git(wt, "rev-parse", "HEAD^{tree}"), tree, "the tree is unchanged");
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "agentry/T1");
  assert.equal(git(wt, "status", "--porcelain"), "");
});
