// Tests for lib/process/ledger.mjs: per-task state under the main root, atomic writes, run dirs.
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
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { idProblem } from "../lib/lane/id.mjs";
import { create, mainRoot } from "../lib/lane/worktree.mjs";
import { archive, archives, list, read, runDir, write } from "../lib/process/ledger.mjs";
import { tempRepo } from "./git-repo.mjs";

let root;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ledger-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ledger = (id, extra = {}) => ({
  v: 1,
  id,
  kind: "task",
  state: "building",
  rounds: [],
  ...extra,
});
const dirOf = (r) => join(r, ".agentry", "run", "process", "ledger");

test("write then read round-trips, stamps updatedAt, and leaves no temp file", () => {
  const written = write(root, ledger("T-1"));
  assert.match(written.updatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(read(root, "T-1"), written);
  assert.deepEqual(readdirSync(dirOf(root)), ["T-1.json"]);
});

test("write replaces the previous ledger in place", () => {
  write(root, ledger("T-1"));
  write(root, ledger("T-1", { state: "verified" }));
  assert.equal(read(root, "T-1").state, "verified");
});

test("read is null for an unknown id, a bad id, or a missing ledger directory", () => {
  assert.equal(read(root, "T-9"), null);
  assert.equal(read(root, "../escape"), null);
  assert.equal(read(root, undefined), null);
});

test("read names the file when it is corrupt or not a v1 ledger for that id", () => {
  write(root, ledger("T-1"));
  writeFileSync(join(dirOf(root), "T-1.json"), "{ nope");
  assert.throws(() => read(root, "T-1"), /T-1\.json is not valid JSON/);
  writeFileSync(join(dirOf(root), "T-1.json"), JSON.stringify({ v: 2, id: "T-1" }));
  assert.throws(() => read(root, "T-1"), /not a v1 ledger/);
  writeFileSync(join(dirOf(root), "T-1.json"), JSON.stringify({ v: 1, id: "T-2" }));
  assert.throws(() => read(root, "T-1"), /not a v1 ledger/);
});

test("write refuses a bad id or version without touching disk", () => {
  assert.throws(() => write(root, ledger("../x")), /plain id/);
  assert.throws(() => write(root, ledger("a..b")), /plain id/);
  assert.throws(() => write(root, { ...ledger("T-1"), v: 2 }), /v: 1/);
  assert.equal(existsSync(dirOf(root)), false);
});

test("write refuses an id that differs from an existing one only by case; read of it is null", () => {
  write(root, ledger("T-1", { state: "verified" }));
  assert.throws(() => write(root, ledger("t-1")), /differs only by case from "T-1"/);
  assert.equal(read(root, "t-1"), null); // never throws on, or returns, the other spelling's file
  assert.equal(read(root, "T-1").state, "verified");
  assert.deepEqual(
    list(root).map((l) => l.id),
    ["T-1"],
  );
  assert.doesNotThrow(() => write(root, ledger("T-1")));
});

test("the ledger takes exactly the ids the worktree takes", () => {
  const ids = [
    "x.lock",
    "x.lock.y",
    "a.",
    "-x",
    "a b",
    "café",
    "a/b",
    "a".repeat(300),
    "T-1",
    "DS.1_a",
  ];
  for (const id of ids) {
    assert.equal(read(root, id), null, id); // an unusable id never reads a file
    if (idProblem(id)) assert.throws(() => write(root, ledger(id)), /plain id/, id);
    else assert.doesNotThrow(() => write(root, ledger(id)), id);
  }
});

test("list returns ledgers sorted by id and skips an unreadable one", () => {
  assert.deepEqual(list(root), []);
  write(root, ledger("B-2"));
  write(root, ledger("A-1"));
  writeFileSync(join(dirOf(root), "C-3.json"), "garbage");
  assert.deepEqual(
    list(root).map((l) => l.id),
    ["A-1", "B-2"],
  );
});

test("list names each file it skips and why", () => {
  write(root, ledger("A-1"));
  writeFileSync(join(dirOf(root), "C-3.json"), "garbage");
  const listed = list(root);
  assert.deepEqual(
    listed.map((l) => l.id),
    ["A-1"],
  );
  assert.deepEqual(
    listed.skipped.map((s) => s.file),
    [join(dirOf(root), "C-3.json")],
  );
  assert.match(listed.skipped[0].why, /not valid JSON/);
  assert.deepEqual(list(root, { sweep: false }).skipped.length, 1);
});

// ---- archives (process review P1-1) ------------------------------------------------------------------

const runsOf = (r) => join(r, ".agentry", "run", "process", "runs");
// The flat archive an older restart left: `T-1`'s ledger renamed `T-1.2.json`, a name the valid id
// `T-1.2` also reaches.
const flatArchive = (r, id, n, extra = {}) => {
  mkdirSync(dirOf(r), { recursive: true });
  const text = `${JSON.stringify(ledger(id, extra), null, 2)}\n`;
  writeFileSync(join(dirOf(r), `${id}.${n}.json`), text);
  return text;
};

test("an older restart's flat archive <id>.<n>.json is no ledger of the id <id>.<n>, and never blocks it", () => {
  write(root, ledger("T-1"));
  const text = flatArchive(root, "T-1", 2, { state: "held" });
  mkdirSync(join(runsOf(root), "T-1.2"), { recursive: true }); // its flat run dir
  assert.equal(read(root, "T-1.2"), null);
  const listed = list(root);
  assert.deepEqual(
    listed.map((l) => l.id),
    ["T-1"],
  );
  assert.deepEqual(listed.skipped, [
    { file: join(dirOf(root), "T-1.2.json"), why: "an archive of T-1 (restart 2)" },
  ]);
  assert.deepEqual(archives(root, "T-1"), [
    { n: 2, file: join(dirOf(root), "T-1.2.json"), runs: join(runsOf(root), "T-1.2") },
  ]);
  // The real T-1.2 takes its name; the archive it held moves under .archive/, byte for byte.
  write(root, ledger("T-1.2", { state: "verified" }));
  assert.equal(read(root, "T-1.2").state, "verified");
  assert.equal(readFileSync(join(dirOf(root), ".archive", "T-1.2.json"), "utf8"), text);
  assert.deepEqual(
    archives(root, "T-1").map((a) => [a.n, a.file]),
    [[2, join(dirOf(root), ".archive", "T-1.2.json")]],
  );
  assert.deepEqual(
    list(root)
      .map((l) => l.id)
      .sort(),
    ["T-1", "T-1.2"],
  );
});

test("archive moves the ledger to ledger/.archive/<id>.<n>.json and the run dir to runs/.archive/<id>.<n>", () => {
  write(root, ledger("T-1"));
  write(root, ledger("T-1.2", { state: "verified" }));
  const before = readFileSync(join(dirOf(root), "T-1.json"), "utf8");
  writeFileSync(join(runDir(root, "T-1"), "r1-build.md"), "brief\n");
  const archived = {
    ledger: join(dirOf(root), ".archive", "T-1.2.json"),
    runs: join(runsOf(root), ".archive", "T-1.2"),
  };
  assert.deepEqual(archive(root, "T-1", 2), archived);
  assert.equal(readFileSync(archived.ledger, "utf8"), before);
  assert.equal(readFileSync(join(archived.runs, "r1-build.md"), "utf8"), "brief\n");
  assert.deepEqual(archives(root, "T-1"), [{ n: 2, file: archived.ledger, runs: archived.runs }]);
  assert.equal(read(root, "T-1"), null);
  assert.equal(read(root, "T-1.2").state, "verified", "the real T-1.2 is untouched");
  assert.deepEqual(
    list(root).map((l) => l.id),
    ["T-1.2"],
  );
  assert.deepEqual(list(root).skipped, []);
});

test("a real T-1.2 started after T-1's archive 2 has a run dir of its own", () => {
  write(root, ledger("T-1"));
  writeFileSync(join(runDir(root, "T-1"), "r1-build.md"), "T-1's brief\n");
  const archived = archive(root, "T-1", 2);
  write(root, ledger("T-1.2"));
  const own = runDir(root, "T-1.2");
  assert.equal(own, join(runsOf(root), "T-1.2"));
  assert.notEqual(own, archived.runs);
  assert.deepEqual(readdirSync(own), [], "none of T-1's files");
  assert.deepEqual(readdirSync(archived.runs), ["r1-build.md"]);
});

test("archive never overwrites one of any layout, and archives lists them all by number", () => {
  write(root, ledger("T-1"));
  flatArchive(root, "T-1", 1);
  assert.throws(() => archive(root, "T-1", 1), /an archive T-1\.1 exists/);
  assert.equal(read(root, "T-1").id, "T-1", "nothing moved");
  // `ledger/archive/`, a layout no release wrote, and a run dir an archive cut short left alone.
  mkdirSync(join(dirOf(root), "archive"));
  writeFileSync(join(dirOf(root), "archive", "T-1.2.json"), JSON.stringify(ledger("T-1")));
  mkdirSync(join(runsOf(root), ".archive", "T-1.4"), { recursive: true });
  for (const n of [2, 4]) assert.throws(() => archive(root, "T-1", n), /an archive T-1\.\d exists/);
  archive(root, "T-1", 3);
  write(root, ledger("T-1"));
  assert.throws(() => archive(root, "T-1", 3), /an archive T-1\.3 exists/);
  assert.deepEqual(
    archives(root, "T-1").map((a) => [a.n, a.file]),
    [
      [1, join(dirOf(root), "T-1.1.json")],
      [2, join(dirOf(root), "archive", "T-1.2.json")],
      [3, join(dirOf(root), ".archive", "T-1.3.json")],
      [4, null],
    ],
  );
  write(root, ledger("T-1.5"));
  assert.deepEqual(
    archives(root, "T-1").map((a) => a.n),
    [1, 2, 3, 4],
    "the real ledger of T-1.5 is no archive of T-1",
  );
  assert.deepEqual(archives(root, "T-9"), []);
});

test("runDir creates the task's directory under process/runs", () => {
  const dir = runDir(root, "T-1");
  assert.equal(dir, join(root, ".agentry", "run", "process", "runs", "T-1"));
  assert.equal(existsSync(dir), true);
  assert.equal(runDir(root, "T-1"), dir);
  assert.throws(() => runDir(root, "../x"), /plain id/);
});

test("a ledger written from inside a worktree lands under the main checkout", () => {
  const repo = tempRepo();
  try {
    const made = create(repo.dir, { id: "T-1", base: "main" });
    const main = mainRoot(made.path);
    write(main, ledger("T-1"));
    assert.equal(
      existsSync(join(repo.dir, ".agentry", "run", "process", "ledger", "T-1.json")),
      true,
    );
    assert.equal(existsSync(join(made.path, ".agentry")), false);
  } finally {
    repo.cleanup();
  }
});

test("a writer killed between write and rename leaves a temp file the next read or list removes", () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  write(root, ledger("T-1"));
  const dir = dirOf(root);
  const live = `T-2.json.agentry-${process.ppid}.tmp`;
  writeFileSync(join(dir, `T-1.json.agentry-${dead}.tmp`), "{half");
  writeFileSync(join(dir, live), "{");
  assert.equal(read(root, "T-1").id, "T-1");
  assert.deepEqual(readdirSync(dir).sort(), ["T-1.json", live], "a live writer's temp stays");
  writeFileSync(join(dir, `T-1.json.agentry-${dead}.tmp`), "{half");
  assert.equal(list(root).length, 1);
  assert.deepEqual(readdirSync(dir).sort(), ["T-1.json", live]);
});

test("a temp file of the older naming (<id>.json.<pid>.tmp) a killed writer left is swept too", () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  write(root, ledger("T-1"));
  const dir = dirOf(root);
  const live = `T-2.json.${process.ppid}.tmp`;
  writeFileSync(join(dir, `T-1.json.${dead}.tmp`), "{half");
  writeFileSync(join(dir, live), "{");
  assert.equal(list(root).length, 1);
  assert.deepEqual(readdirSync(dir).sort(), ["T-1.json", live], "a live writer's temp stays");
});
