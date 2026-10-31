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
import { canSkip, changedSince, pickTier, runGate } from "../lib/lane/gate.mjs";
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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a gate that outlives timeoutSec is killed, with its children, and is red", async () => {
  const pidFile = join(logs, "child.pid");
  const code = `
    const { spawn } = require('child_process');
    const kid = spawn('sleep', ['60'], { stdio: 'ignore' });
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
    setTimeout(() => {}, 60000);`;
  const started = Date.now();
  const res = runGate(repo.dir, node(code), { tier: "full", logFile: log, timeoutSec: 1 });
  assert.ok(Date.now() - started < 20000);
  assert.notEqual(res.exit, 0);
  assert.match(readFileSync(log, "utf8"), /timed out after 1 s/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false);
});

test("a gate within timeoutSec is unaffected, and a bad timeoutSec is refused", () => {
  const res = runGate(repo.dir, node("0"), { tier: "full", logFile: log, timeoutSec: 30 });
  assert.equal(res.exit, 0);
  for (const timeoutSec of [0, -1, "5", Number.NaN])
    assert.throws(
      () => runGate(repo.dir, node("0"), { tier: "full", logFile: log, timeoutSec }),
      TypeError,
    );
});

test("a gate that commits moves HEAD and is red", () => {
  const before = git(repo.dir, "rev-parse", "HEAD");
  const commit =
    "echo c > c.txt && git add c.txt && git -c user.name=t -c user.email=t@t commit -qm c";
  const res = runGate(repo.dir, ["sh", "-c", commit], { tier: "full", logFile: log });
  assert.notEqual(git(repo.dir, "rev-parse", "HEAD"), before);
  assert.equal(res.exit, 1);
  assert.equal(res.commandExit, 0);
  assert.equal(res.commit, before);
  assert.match(readFileSync(log, "utf8"), /the gate changed HEAD/);
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

test("globs: ** never crosses a .. segment or a partial segment, and odd paths never match", () => {
  const only = (glob, file) =>
    pickTier({ command: ["t"], quick: { command: ["q"], only: [glob] } }, [file]).tier === "quick";
  assert.equal(only("docs/**", "docs/a/b.md"), true);
  assert.equal(only("**/*.md", "a/b/c.md"), true);
  assert.equal(only("docs/**/x.md", "docs/x.md"), true);
  assert.equal(only("docs/**", "./docs/a.md"), true); // a leading ./ is normalised
  assert.equal(only("docs/**", "docs/../src/x"), false);
  assert.equal(only("**", "../outside"), false);
  assert.equal(only("**/x", "docs/../x"), false);
  assert.equal(only("docs/**", "docs-evil/x"), false);
  assert.equal(only("docs/**", "/docs/x"), false);
  assert.equal(only("docs/a**b", "docs/a/zzz/b"), false); // ** inside a segment is just *
  assert.equal(only("docs/a**b", "docs/axyzb"), true);
  assert.equal(only("docs/../src/**", "docs/../src/x"), false);
});

const record = { exit: 0, tier: "full", cleanBefore: true, cleanAfter: true, tree: "t1" };
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

test("canSkip: a moved tree skips only when the listed docs files explain it", () => {
  const moved = { ...ok, record: { ...record, tree: "t0" } };
  assert.equal(canSkip({ ...moved, changedSinceGate: ["docs/x.md"] }).skip, true);
});

test("changedSince lists a rename out of src/ into docs/ as both paths", () => {
  commitFile(repo.dir, "src/a.txt", "a\n".repeat(20));
  const gated = git(repo.dir, "rev-parse", "HEAD");
  assert.deepEqual(changedSince(repo.dir, gated), []);
  git(repo.dir, "mv", "src/a.txt", "docs-a.txt");
  git(repo.dir, "commit", "-q", "-m", "move");
  assert.deepEqual(changedSince(repo.dir, gated).sort(), ["docs-a.txt", "src/a.txt"]);
  assert.equal(changedSince(repo.dir, "no-such-commit"), null);
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
    [{ ...ok, changedSinceGate: undefined }, /unknown changes since the gate/],
    [{ ...ok, changedSinceGate: "docs/x.md" }, /unknown changes since the gate/],
    [{ ...ok, record: { ...record, tree: undefined } }, /no tree/],
    // the tree moved since the gate, but nothing is listed to explain it
    [{ ...ok, record: { ...record, tree: "t0" }, changedSinceGate: [] }, /no changed files/],
  ];
  for (const [input, why] of cases) {
    const res = canSkip(input);
    assert.equal(res.skip, false);
    assert.match(res.reason, why);
  }
});
