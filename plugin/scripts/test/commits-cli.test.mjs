// Tests for `board commits --learn` (lib/process/cli/commits.mjs): the rules the default branch's
// first-parent history keeps, printed and never written, on temp repos with no process file.
// Run: node --test plugin/scripts/test/commits-cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { STANDARD_TYPES } from "../lib/process/commits.mjs";
import { commitFile, git, gitEnv, tempRepo } from "./git-repo.mjs";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");
const repos = [];
after(() => {
  for (const r of repos) r.cleanup();
});
/** A repo on main whose history (after `init`) is `subjects`, oldest first. */
function repoWith(subjects) {
  const r = tempRepo();
  repos.push(r);
  subjects.forEach((subject, i) => commitFile(r.dir, `f${i}.txt`, `${i}\n`, subject));
  return r.dir;
}
const learn = (dir, ...args) =>
  spawnSync("node", [BOARD, "commits", "--learn", ...args, "--root", dir], {
    encoding: "utf8",
    env: { ...gitEnv, NO_COLOR: "1" },
  });
const json = (dir, ...args) => {
  const res = learn(dir, "--json", ...args);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};
const many = (subject, n) => Array.from({ length: n }, () => subject);

test("--learn prints the standard types and each other type used --min times, with counts", () => {
  const dir = repoWith([...many("feat: a", 2), ...many("art: b", 3), "fix(x): c"]);
  const res = learn(dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /learned from 7 first-parent commit\(s\) of main/);
  assert.match(res.stdout, /subjectPattern {2}"\^\(feat\|fix\|docs\|.*\|revert\|art\)/);
  assert.match(res.stdout, /subjectMax {6}72/);
  assert.match(res.stdout, /scoped {10}no/);
  assert.match(res.stdout, /types {11}feat 2, fix 1, docs 0,.* art 3 \(not standard\)/);
});

test("--json prints { types, subjectPattern, subjectMax, scoped }, the pattern taking the repo's types", () => {
  const dir = repoWith([...many("art(lvl): b", 3), "feat(core): a"]);
  const got = json(dir);
  assert.deepEqual(Object.keys(got), ["types", "subjectPattern", "subjectMax", "scoped"]);
  assert.deepEqual(got.types.at(-1), { type: "art", count: 3, standard: false });
  assert.deepEqual(got.types[0], { type: "feat", count: 1, standard: true });
  assert.equal(got.scoped, true);
  assert.equal(got.subjectMax, 72);
  const re = new RegExp(got.subjectPattern);
  assert.match("art(lvl): b", re);
  assert.doesNotMatch("art: no scope", re, "scopes are always there, so the pattern needs one");
});

test("a type used fewer than --min times is not added; --min lowers or raises the bar", () => {
  const dir = repoWith([...many("art: a", 2), ...many("lore: b", 4)]);
  const extra = (got) => got.types.filter((t) => !t.standard).map((t) => t.type);
  assert.deepEqual(extra(json(dir)), ["lore"], "default 3");
  assert.deepEqual(extra(json(dir, "--min", "2")), ["lore", "art"]);
  assert.deepEqual(extra(json(dir, "--min=5")), []);
  assert.doesNotMatch("art: a", new RegExp(json(dir).subjectPattern));
});

test("only the default branch's first-parent line counts: a merged side branch's commits do not", () => {
  const dir = repoWith(["feat: a"]);
  git(dir, "switch", "-q", "-c", "side");
  for (let i = 0; i < 3; i++) commitFile(dir, `s${i}.txt`, "s", `art: side ${i}`);
  git(dir, "switch", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
  assert.equal(
    json(dir).types.some((t) => t.type === "art"),
    false,
  );
});

test("--learn writes nothing: the tree, the index and .agentry are as they were", () => {
  const dir = repoWith(["feat: a", "art: b"]);
  const before = [git(dir, "status", "--porcelain", "--ignored"), readdirSync(dir).sort()];
  assert.equal(learn(dir).status, 0);
  assert.equal(learn(dir, "--json").status, 0);
  assert.deepEqual(
    [git(dir, "status", "--porcelain", "--ignored"), readdirSync(dir).sort()],
    before,
  );
});

/** A new directory, removed after the run. */
function emptyDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "commits-empty-")));
  repos.push({ cleanup: () => rmSync(dir, { recursive: true, force: true }) });
  return dir;
}

test("a repo with no history prints the standard set and says so: no commits on its branch yet", () => {
  const dir = emptyDir();
  git(dir, "init", "-q", "-b", "main");
  const res = learn(dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no commits on main yet: the standard Conventional Commits set/);
  const got = json(dir);
  assert.deepEqual(
    got.types.map((t) => [t.type, t.count, t.standard]),
    STANDARD_TYPES.map((t) => [t, 0, true]),
  );
  assert.equal(got.subjectMax, 72);
  assert.equal(got.scoped, false);
});

test("usage: --learn is needed, --min takes a whole number of 1 or more, nothing else is taken", () => {
  const dir = repoWith([]);
  const run = (...args) =>
    spawnSync("node", [BOARD, "commits", ...args, "--root", dir], {
      encoding: "utf8",
      env: gitEnv,
    });
  for (const args of [
    [],
    ["--learn", "--min", "0"],
    ["--learn", "--min", "x"],
    ["--learn", "extra"],
  ]) {
    const res = run(...args);
    assert.equal(res.status, 2, args.join(" "));
    assert.match(res.stderr, /^✗ board commits: /);
  }
  assert.equal(run("--learn", "--min", "1").status, 0);
});

test("outside a git repository --learn refuses with exit 2, printing no rules", () => {
  const dir = emptyDir();
  for (const extra of [[], ["--json"]]) {
    const res = learn(dir, ...extra);
    assert.equal(res.status, 2, res.stdout);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /^✗ board commits: .* is not a git repository/);
  }
  assert.deepEqual(readdirSync(dir), [], "nothing written");
});
