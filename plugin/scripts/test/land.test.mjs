// Tests for lib/lane/{land,carry-io,gate-group}.mjs on throwaway repositories: what a branch has to
// land, the cherry-pick that aborts on any stop, which picks main holds (read from main), git mid-pick,
// the rollback's guards and its `--keep`, the carry patch, the board commit's exactness, the attribution
// check, the push without an upstream, the cleanup's refusals and the gate group a killed run leaves
// behind.
// (`merge-cli.test.mjs` runs them as one land.)
// Run: node --test plugin/scripts/test/land.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { sha256, uncommittedPatch } from "../lib/lane/carry-io.mjs";
import { endStrayGate, gateArgv } from "../lib/lane/gate-group.mjs";
import {
  DEFAULT_DISPOSABLE,
  attributionIn,
  boardCommit,
  cherryPick,
  cleanup,
  ignoredIn,
  landedSince,
  pickInProgress,
  push,
  rollback,
  statusEntries,
  toLand,
} from "../lib/lane/land.mjs";
import { create } from "../lib/lane/worktree.mjs";
import { commitFile, git, gitEnv, tempRepo } from "./git-repo.mjs";

// The library's own git calls (cherry-pick, commit) need the fixture's identity, not the developer's.
Object.assign(process.env, gitEnv);

let repo;
beforeEach(() => {
  repo = tempRepo();
});
afterEach(() => repo.cleanup());

const head = () => git(repo.dir, "rev-parse", "HEAD");
/** A branch `b` off main with one commit per file. */
function branch(files) {
  writeFileSync(join(repo.dir, ".git", "info", "exclude"), ".agentry/\n"); // the worktree lives there
  git(repo.dir, "branch", "b");
  const { path } = create(repo.dir, { id: "B", base: "b" });
  git(path, "checkout", "-q", "b");
  return Object.entries(files).map(([file, text]) => commitFile(path, file, text));
}

test("toLand lists the picks oldest first and leaves out what is already on main by patch", () => {
  const [one, two] = branch({ "a.txt": "a\n", "b.txt": "b\n" });
  commitFile(repo.dir, "main.txt", "main moved\n");
  git(repo.dir, "cherry-pick", one); // landed by hand, as a new commit
  const plan = toLand(repo.dir, { main: "main", branch: "b" });
  assert.deepEqual(plan.picks, [two]);
  assert.deepEqual(plan.onMain, [one]);
  assert.deepEqual(plan.merges, []);
  assert.match(toLand(repo.dir, { main: "main", branch: "nope" }).error, /not a commit/);
});

test("cherryPick lands the commits as new ones on main", () => {
  const shas = branch({ "a.txt": "a\n", "b.txt": "b\n" });
  const preHead = head();
  const res = cherryPick(repo.dir, { shas, preHead });
  assert.deepEqual(res, { ok: true });
  assert.equal(git(repo.dir, "rev-parse", "HEAD~2"), preHead);
});

test("landedSince reads the picks from main's first-parent history, never from the pick call", () => {
  const shas = branch({ "a.txt": "a\n", "b.txt": "b\n" });
  const preHead = head();
  assert.deepEqual(landedSince(repo.dir, { preHead, planned: shas }), { landed: [], rest: shas });
  git(repo.dir, "cherry-pick", shas[0]);
  const one = landedSince(repo.dir, { preHead, planned: shas });
  assert.deepEqual(one, { landed: [head()], rest: [shas[1]] });
  git(repo.dir, "cherry-pick", shas[1]);
  const both = landedSince(repo.dir, { preHead, planned: shas });
  const onMain = git(repo.dir, "rev-list", "--reverse", `${preHead}..HEAD`).split("\n");
  assert.deepEqual(both, { landed: onMain, rest: [] });
  commitFile(repo.dir, "x.txt", "someone else\n");
  assert.match(landedSince(repo.dir, { preHead, planned: shas }).error, /more than the 2 planned/);
  git(repo.dir, "reset", "-q", "--hard", "HEAD~2");
  commitFile(repo.dir, "y.txt", "a stranger\n");
  const stranger = landedSince(repo.dir, { preHead, planned: shas });
  assert.match(stranger.error, /is not the planned pick of/);
});

test("pickInProgress sees a cherry-pick git stopped in the middle of", () => {
  const shas = branch({ "ok.txt": "fine\n", "c.txt": "branch\n" });
  commitFile(repo.dir, "c.txt", "main\n");
  assert.deepEqual(pickInProgress(repo.dir), []);
  spawnSync("git", ["-C", repo.dir, "cherry-pick", ...shas], { env: gitEnv });
  assert.deepEqual(
    pickInProgress(repo.dir).map((p) => p.name),
    ["sequencer", "CHERRY_PICK_HEAD"],
  );
  git(repo.dir, "cherry-pick", "--abort");
  assert.deepEqual(pickInProgress(repo.dir), []);
});

test("cherryPick aborts a sequence that stops midway: main is back at preHead", () => {
  const shas = branch({ "ok.txt": "fine\n", "c.txt": "branch\n" });
  commitFile(repo.dir, "c.txt", "main\n");
  const preHead = head();
  const res = cherryPick(repo.dir, { shas, preHead });
  assert.equal(res.ok, false);
  assert.equal(res.stopped, shas[1]);
  assert.equal(res.restored, true);
  assert.equal(head(), preHead);
  assert.equal(existsSync(join(repo.dir, "ok.txt")), false);
});

test("rollback refuses when main holds more than the landed commits, or is not clean", () => {
  const preHead = head();
  const landed = [commitFile(repo.dir, "a.txt", "a\n")];
  commitFile(repo.dir, "someone-else.txt", "x\n");
  assert.match(rollback(repo.dir, { preHead, landed }).reason, /not exactly the 1 landed/);
  git(repo.dir, "reset", "-q", "--hard", landed[0]);
  writeFileSync(join(repo.dir, "left.txt"), "left by the gate\n");
  assert.match(rollback(repo.dir, { preHead, landed }).reason, /not clean/);
  assert.equal(head(), landed[0]);
});

test("rollback resets to preHead when main is exactly preHead plus the landed commits", () => {
  const preHead = head();
  const landed = [commitFile(repo.dir, "a.txt", "a\n"), commitFile(repo.dir, "b.txt", "b\n")];
  assert.deepEqual(rollback(repo.dir, { preHead, landed }), { ok: true });
  assert.equal(head(), preHead);
});

test("rollback resets with --keep, so a local edit git status cannot see survives", () => {
  commitFile(repo.dir, "local.cfg", "committed\n");
  const preHead = head();
  const landed = [commitFile(repo.dir, "a.txt", "a\n")];
  git(repo.dir, "update-index", "--assume-unchanged", "local.cfg");
  writeFileSync(join(repo.dir, "local.cfg"), "MY LOCAL WORK\n");
  assert.deepEqual(rollback(repo.dir, { preHead, landed }), { ok: true });
  assert.equal(head(), preHead);
  assert.equal(readFileSync(join(repo.dir, "local.cfg"), "utf8"), "MY LOCAL WORK\n");
});

test("uncommittedPatch records an edit against HEAD with its sha256", () => {
  commitFile(repo.dir, "board.md", "one\ntwo\n");
  writeFileSync(join(repo.dir, "board.md"), "one\nTWO\n");
  const carry = uncommittedPatch(repo.dir, ["board.md"]);
  assert.equal(carry.sha256, sha256(carry.patch));
  assert.match(carry.patch, /^\+TWO$/m);
  assert.equal(uncommittedPatch(repo.dir, ["board.md"]).sha256, carry.sha256);
});

// R1b-5 notes item 4: the clean check split git's output on its own, so a rename's source came out as
// an entry of its own, cut to "n/TASKS.md".
test("statusEntries reads a rename as its delete and its add", () => {
  commitFile(repo.dir, "plan/TASKS.md", "tasks\n");
  git(repo.dir, "mv", "plan/TASKS.md", "plan/T.md");
  assert.deepEqual(statusEntries(repo.dir).sort(), ["A  plan/T.md", "D  plan/TASKS.md"]);
});

// A gate the way a merge runs it, from a parent that then dies (as a killed merge does): the wrapper is
// detached, so its group outlives the parent.
function strayGate(cmd, nonce) {
  const pidFile = join(repo.dir, ".git", `gate-${nonce}.pid`);
  const argv = gateArgv(cmd, { pidFile, nonce });
  const start = `require("node:child_process").spawn(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))}, { detached: true, stdio: "ignore" }).unref()`;
  spawnSync(process.execPath, ["-e", start]);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const until = (condition) => {
    for (let i = 0; i < 250 && !condition(); i++) Atomics.wait(nap, 0, 0, 20);
  };
  // The file exists before the wrapper has written its pid into it: wait for the pid, not the file.
  const pidOf = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0);
  until(pidOf);
  const pgid = pidOf();
  // The pid lands before the wrapper starts the gate. A kill in that gap can miss a gate that forks as
  // the signal arrives, and under load that left `sleep` running: wait until the gate is in the group.
  const members = () =>
    spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(Boolean).length;
  until(() => members() >= 2);
  return { pidFile, nonce, pgid };
}

test("endStrayGate kills the gate group a killed run left, and leaves a reused pid alone", () => {
  const gate = strayGate(["sleep", "30"], "c0ffee01");
  assert.deepEqual(endStrayGate(gate), { ok: true, pgid: gate.pgid, killed: true });
  assert.throws(() => process.kill(-gate.pgid, 0), { code: "ESRCH" });
  assert.deepEqual(endStrayGate(gate), { ok: true, pgid: gate.pgid, killed: false });
  const none = { pidFile: join(repo.dir, "none.pid"), nonce: "x" };
  assert.deepEqual(endStrayGate(none), { ok: true, pgid: null, killed: false });
  // A live group whose leader is not that gate (its pid was reused): untouched.
  const other = strayGate(["sleep", "30"], "c0ffee02");
  assert.deepEqual(endStrayGate({ ...other, nonce: "not-this-one" }), {
    ok: true,
    pgid: other.pgid,
    killed: false,
  });
  process.kill(-other.pgid, 0); // still alive
  endStrayGate(other);
});

// R1b-5 re-verify item 11: the nonce sits past the wrapper's long script in the argv, so a `ps` that
// cuts its output to 80 columns (procps documents that default for a pipe) lost it and took the gate
// for a reused pid. A `ps` in front of the real one cuts like that unless asked for unlimited width.
test("endStrayGate finds the nonce even where ps cuts its output short", () => {
  const gate = strayGate(["sleep", "30"], "c0ffee03");
  const realPs = process.env.PATH.split(":")
    .map((dir) => join(dir, "ps"))
    .find((file) => existsSync(file));
  const dir = join(repo.dir, ".git", "narrow");
  mkdirSync(dir);
  const shim = `#!/bin/sh\n[ "$1" = -ww ] && exec "${realPs}" "$@"\n"${realPs}" "$@" | cut -c1-80\n`;
  writeFileSync(join(dir, "ps"), shim);
  chmodSync(join(dir, "ps"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    assert.deepEqual(endStrayGate(gate), { ok: true, pgid: gate.pgid, killed: true });
  } finally {
    process.env.PATH = path;
    try {
      process.kill(-gate.pgid, "SIGKILL");
    } catch {
      // gone already: the case the test wants
    }
  }
});

test("the gate wrapper passes the gate's argv and exit code through", () => {
  const pidFile = join(repo.dir, ".git", "gate.pid");
  const argv = gateArgv(["sh", "-c", 'echo "$*"; exit 3', "sh", "--x", "a b"], {
    pidFile,
    nonce: "n",
  });
  const res = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  assert.equal(res.status, 3);
  assert.equal(res.stdout, "--x a b\n");
  assert.match(readFileSync(pidFile, "utf8"), /^\d+$/);
});

test("boardCommit commits exactly the named files and refuses any other change", () => {
  commitFile(repo.dir, "board.md", "one\n");
  writeFileSync(join(repo.dir, "board.md"), "two\n");
  writeFileSync(join(repo.dir, "stray.txt"), "x\n");
  const refused = boardCommit(repo.dir, { files: ["board.md"], message: "docs: board" });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /other changes: \?\? stray\.txt/);
  git(repo.dir, "clean", "-q", "-f");
  const res = boardCommit(repo.dir, { files: ["board.md"], message: "docs: board" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.left, []);
  assert.equal(
    git(repo.dir, "show", "--name-only", "--format=%s", "HEAD"),
    "docs: board\n\nboard.md",
  );
});

test("attributionIn finds an AI credit on any line and passes a plain message", () => {
  for (const line of [
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "co-authored-by: GPT-4 <x@y>",
    "Claude-Session: https://claude.ai/code/x",
    "Generated with Claude Code",
    "🤖 done",
  ])
    assert.equal(attributionIn(`docs(board): land T1\n\n${line}`), line, line);
  assert.equal(
    attributionIn("docs(board): land T1\n\nCo-Authored-By: Ada <ada@example.com>"),
    null,
  );
  assert.equal(attributionIn("fix(ai-engine): steer the guards"), null);
});

test("push refuses a branch with no upstream", () => {
  assert.match(push(repo.dir, { branch: "main" }).reason, /no upstream/);
});

test("cleanup keeps a worktree with uncommitted work, and its branch", () => {
  branch({ "a.txt": "a\n" });
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  writeFileSync(join(path, "wip.txt"), "unsaved\n");
  const res = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: path });
  assert.equal(res.ok, false);
  assert.match(res.reason, /uncommitted changes/);
  assert.ok(existsSync(path));
});

test("a dir/** disposable glob takes the wholly ignored directory; a near name still asks", () => {
  branch({ ".gitignore": "build/\nbuilds/\n" });
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  for (const dir of ["build", "builds"]) {
    mkdirSync(join(path, dir));
    writeFileSync(join(path, dir, "out.o"), "x");
  }
  const res = cleanup(repo.dir, {
    branch: "b",
    main: "main",
    fallbackPath: path,
    disposable: ["build/**"],
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.ignored, ["builds/"]);
  assert.deepEqual(res.disposable, ["build/"]);
  assert.ok(existsSync(path));
});

test("an ignored directory holding no file at any depth never blocks the cleanup", () => {
  branch({ ".gitignore": "cache/\nkept/\n" });
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  mkdirSync(join(path, "cache", "a", "b"), { recursive: true });
  mkdirSync(join(path, "kept"));
  writeFileSync(join(path, "kept", "note.txt"), "x");
  const blocked = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: path });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.ignored, ["kept/"]);
  assert.equal(blocked.disposable, undefined, "an empty directory is no disposable path either");
  rmSync(join(path, "kept"), { recursive: true });
  const res = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: path });
  assert.equal(res.ignored, undefined);
  assert.ok(!existsSync(path));
});

test("a folder with the cache and one other file refuses the cleanup and removes nothing", () => {
  branch({ ".gitignore": "art/\n" });
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  mkdirSync(join(path, "art", "preview"), { recursive: true });
  writeFileSync(join(path, "art", "preview", "shot.png"), "x");
  writeFileSync(join(path, "art", "keep.psd"), "x");
  const found = ignoredIn(path, ["art/preview/**"]);
  assert.deepEqual(found.ignored, ["art/"]);
  assert.deepEqual(found.disposable, []);
  const res = cleanup(repo.dir, {
    branch: "b",
    main: "main",
    fallbackPath: path,
    disposable: ["art/preview/**"],
  });
  assert.equal(res.ok, false);
  assert.ok(existsSync(join(path, "art", "keep.psd")));
  assert.ok(existsSync(join(path, "art", "preview", "shot.png")));
});

test("a folder of cache files and empty subfolders is disposable and the cleanup removes it", () => {
  branch({ ".gitignore": "art/\n" });
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  mkdirSync(join(path, "art", "preview"), { recursive: true });
  writeFileSync(join(path, "art", "preview", "shot.png"), "x");
  mkdirSync(join(path, "art", "empty", "deeper"), { recursive: true });
  const res = cleanup(repo.dir, {
    branch: "b",
    main: "main",
    fallbackPath: path,
    disposable: ["art/preview/**"],
  });
  assert.equal(res.ignored, undefined, JSON.stringify(res)); // nothing asks; the branch itself is not on main
  assert.equal(res.removed, true);
  assert.ok(!existsSync(path));
});

test("a disposable glob naming a folder covers the files under it, not a near name", () => {
  branch({ ".gitignore": "src/data/*.json\nsrc/database/*.json\n" });
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  for (const dir of ["src/data", "src/database"]) {
    mkdirSync(join(path, dir), { recursive: true });
    writeFileSync(join(path, dir, "a.json"), "{}");
  }
  const res = cleanup(repo.dir, {
    branch: "b",
    main: "main",
    fallbackPath: path,
    disposable: ["src/data"],
  });
  assert.equal(res.ok, false);
  assert.ok(res.disposable.includes("src/data/a.json"));
  assert.ok(res.disposable.every((entry) => entry.startsWith("src/data/")));
  assert.ok(res.ignored.includes("src/database/a.json"));
  assert.ok(res.ignored.every((entry) => !entry.startsWith("src/data/")));
});

// A branch whose only commit ignores build output, landed on main by hand so cleanup can delete it.
function ignoringBranch() {
  const shas = branch({
    ".gitignore": "node_modules/\ndist/\n.env\n",
    "packages/web/package.json": "{}\n",
  });
  for (const sha of shas) git(repo.dir, "cherry-pick", sha);
  return join(repo.dir, ".agentry", "run", "worktrees", "B");
}
function plant(path, ...files) {
  for (const file of files) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), "x");
  }
}

test("cleanup discards ignored node_modules and dist output at any depth with no prompt and no config", () => {
  const path = ignoringBranch();
  plant(path, "node_modules/pkg/index.js", "packages/web/node_modules/dep.js", "dist/out.js");
  const res = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: path });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ignored, undefined);
  assert.deepEqual(res.disposable.sort(), ["dist/", "node_modules/", "packages/web/node_modules/"]);
  assert.ok(!existsSync(path));
  assert.deepEqual(DEFAULT_DISPOSABLE, ["**/node_modules/**", "**/dist/**"]);
});

test("an ignored folder is one disposable entry, however many files it holds", () => {
  const path = ignoringBranch();
  for (let i = 0; i < 300; i++) plant(path, `node_modules/pkg/f${i}.js`);
  const res = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: path });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.disposable, ["node_modules/"]);
});

test("the default disposables add to the configured ones, and any other ignored file still asks", () => {
  const path = ignoringBranch();
  plant(path, "dist/out.js", ".env");
  const res = cleanup(repo.dir, {
    branch: "b",
    main: "main",
    fallbackPath: path,
    disposable: ["cache/**"],
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.ignored, [".env"]);
  assert.deepEqual(res.disposable, ["dist/"]);
  assert.ok(existsSync(path));
});

test("a tracked file under dist is never discarded: only the ignored output is listed", () => {
  const [sha] = branch({ "dist/tracked.js": "kept\n" });
  git(repo.dir, "cherry-pick", sha);
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  writeFileSync(join(repo.dir, ".git", "info", "exclude"), ".agentry/\ndist/out.js\n");
  plant(path, "dist/out.js");
  const res = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: path });
  assert.deepEqual(res.disposable, ["dist/out.js"]);
  assert.equal(readFileSync(join(repo.dir, "dist", "tracked.js"), "utf8"), "kept\n");
});

// A worktree holding ignored files at several depths, cleaned up with `disposable`.
function cleanWith(disposable) {
  branch({ ".gitignore": "*.json\n.env\n" });
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  for (const file of [
    "src/data/gen.json",
    "src/data/nested/deep.json",
    "src/data/.env",
    "src/data-old/keep.json",
    ".env",
  ]) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), "x");
  }
  return cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: path, disposable });
}

for (const glob of ["src/data", "src/data/", "src/data/**"])
  test(`disposable ${glob}: takes the folder's files and its ignored .env, not a near name or the root .env`, () => {
    const res = cleanWith([glob]);
    const taken = res.disposable.filter((f) => f.endsWith(".env") || f.endsWith("deep.json"));
    assert.deepEqual(taken.sort(), ["src/data/.env", "src/data/nested/deep.json"]);
    assert.ok(res.ignored.includes("src/data-old/keep.json"));
    assert.ok(res.ignored.includes(".env"));
  });

for (const glob of ["src/dat", "*.json"])
  test(`disposable ${glob}: keeps the files under src/data`, () => {
    assert.ok(cleanWith([glob]).ignored.includes("src/data/gen.json"));
  });

test("cleanup keeps a branch whose commits are not on main", () => {
  branch({ "a.txt": "a\n" });
  const res = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: "/nowhere" });
  assert.equal(res.removed, true);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not on main/);
  assert.notEqual(git(repo.dir, "branch", "--list", "b"), "");
});
