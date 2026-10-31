// Tests for lib/lane/gate.mjs: runGate on throwaway repos, and the pure pickTier / canSkip tables.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { canSkip, pickTier, runGate } from "../lib/lane/gate.mjs";
import { commitFile, git, tempRepo } from "./git-repo.mjs";

let repo;
let logs;
let log;
beforeEach(() => {
  repo = tempRepo();
  logs = realpathSync(mkdtempSync(join(tmpdir(), "gate-logs-")));
  log = join(logs, "run", "gate.log");
});
afterEach(() => {
  repo.cleanup();
  rmSync(logs, { recursive: true, force: true });
});

const node = (code) => ["node", "-e", code];

test("a passing gate reports exit 0, the commit and tree, clean both sides, and a log", () => {
  const res = runGate(repo.dir, node("console.log('ok')"), { tier: "full", logFile: log });
  assert.equal(res.exit, 0);
  assert.equal(res.tier, "full");
  assert.equal(res.commit, git(repo.dir, "rev-parse", "HEAD"));
  assert.equal(res.tree, git(repo.dir, "rev-parse", "HEAD^{tree}"));
  assert.equal(res.cleanBefore, true);
  assert.equal(res.cleanAfter, true);
  assert.equal(res.log, log);
  assert.equal(typeof res.seconds, "number");
});

test("the gate command's own non-zero exit is reported, even from a script with a pipeline", () => {
  const plain = runGate(repo.dir, node("console.log('x'); process.exit(3)"), {
    tier: "full",
    logFile: log,
  });
  assert.equal(plain.exit, 3);
  commitFile(repo.dir, "gate.sh", "set -o pipefail\nnode -e 'process.exit(7)' | cat\n");
  const piped = runGate(repo.dir, ["bash", "gate.sh"], { tier: "full", logFile: log });
  assert.equal(piped.exit, 7);
});

test("a missing executable is a red gate with the cause in the log", () => {
  const res = runGate(repo.dir, ["no-such-gate-binary-xyz"], { tier: "full", logFile: log });
  assert.notEqual(res.exit, 0);
  assert.match(readFileSync(log, "utf8"), /could not run no-such-gate-binary-xyz/);
});

test("the log file holds both stdout and stderr", () => {
  runGate(repo.dir, node("console.log('to-out'); console.error('to-err')"), {
    tier: "quick",
    logFile: log,
  });
  const text = readFileSync(log, "utf8");
  assert.match(text, /to-out/);
  assert.match(text, /to-err/);
});

test("a dirty tree (an untracked file) is refused before the command starts", () => {
  writeFileSync(join(repo.dir, "stray.txt"), "x");
  const marker = join(logs, "ran");
  const res = runGate(
    repo.dir,
    node(`require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`),
    {
      tier: "full",
      logFile: log,
    },
  );
  assert.deepEqual(res, { refused: "dirty", files: ["?? stray.txt"] });
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(log), false);
});

test("a gate that leaves a file behind is red even when the command exited 0", () => {
  const res = runGate(repo.dir, node("require('fs').writeFileSync('leftover.txt', 'x')"), {
    tier: "full",
    logFile: log,
  });
  assert.equal(res.exit, 1);
  assert.equal(res.commandExit, 0);
  assert.equal(res.cleanAfter, false);
  assert.match(readFileSync(log, "utf8"), /left 1 file\(s\) behind: \?\? leftover\.txt/);
});

test("the command runs at the git root even when started from a subdirectory", () => {
  commitFile(repo.dir, "sub/keep.txt", "k");
  const res = runGate(
    join(repo.dir, "sub"),
    node("process.exit(require('fs').existsSync('README.md') ? 0 : 9)"),
    { tier: "full", logFile: log },
  );
  assert.equal(res.exit, 0);
});

test("runGate rejects an empty or non-array command", () => {
  assert.throws(() => runGate(repo.dir, [], { tier: "full", logFile: log }), TypeError);
  assert.throws(() => runGate(repo.dir, "npm test", { tier: "full", logFile: log }), TypeError);
});

const gate = { command: ["t"], quick: { command: ["q"], only: ["docs/**", "*.md"] } };

test("pickTier: quick only when every changed file matches only", () => {
  assert.equal(pickTier(gate, ["docs/a/b.md", "README.md"]).tier, "quick");
  assert.equal(pickTier(gate, ["docs/a.md", "src/x.mjs"]).tier, "full");
});

test("pickTier: every full result carries a reason", () => {
  const cases = [
    [{ command: ["t"] }, ["a.md"], /no quick tier/],
    [gate, [], /no changed files/],
    [gate, ["src/x.mjs"], /src\/x\.mjs is outside/],
    [gate, ["nested/README.md"], /nested\/README\.md is outside/], // `*` stays in one segment
  ];
  for (const [g, files, why] of cases) {
    const res = pickTier(g, files);
    assert.equal(res.tier, "full");
    assert.match(res.reason, why);
  }
  assert.match(pickTier(gate, ["a.md"]).reason, /match/);
});

const record = { exit: 0, tier: "full", cleanBefore: true, cleanAfter: true };
const ok = {
  record,
  mainTree: "t1",
  branchTipTree: "t1",
  changedSinceGate: [],
  after: ["docs/**"],
};

test("canSkip: skips under all four conditions, including post-gate docs", () => {
  assert.equal(canSkip(ok).skip, true);
  assert.equal(canSkip({ ...ok, changedSinceGate: ["docs/x.md"] }).skip, true);
});

test("canSkip: each failed condition refuses with its own reason", () => {
  const cases = [
    [{ ...ok, record: null }, /no gate record/],
    [{ ...ok, record: { ...record, exit: 1 } }, /exited 1/],
    [{ ...ok, record: { ...record, tier: "quick" } }, /quick tier, not full/],
    [{ ...ok, record: { ...record, tier: undefined } }, /unknown tier, not full/],
    [{ ...ok, record: { ...record, cleanBefore: false } }, /clean tree/],
    [{ ...ok, record: { ...record, cleanAfter: false } }, /clean tree/],
    [{ ...ok, branchTipTree: "t2" }, /tree differs/],
    [{ ...ok, mainTree: undefined, branchTipTree: undefined }, /tree differs/],
    [{ ...ok, changedSinceGate: ["src/x.mjs"] }, /src\/x\.mjs changed since the gate/],
    [{ ...ok, after: undefined, changedSinceGate: ["docs/x.md"] }, /not in "after"/],
  ];
  for (const [input, why] of cases) {
    const res = canSkip(input);
    assert.equal(res.skip, false);
    assert.match(res.reason, why);
  }
});
