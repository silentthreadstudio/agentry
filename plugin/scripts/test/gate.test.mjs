// Tests for lib/lane/gate.mjs: runGate on throwaway repos, the pure pickTier / checklistFor / canSkip
// tables, globMatch, and flakyReds on logs written to disk.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  canSkip,
  changedSince,
  checklistFor,
  flakyReds,
  globMatch,
  pickTier,
  runGate,
} from "../lib/lane/gate.mjs";
import { commitFile, git, gitEnv, tempRepo } from "./git-repo.mjs";

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

test("a background child of a green gate is killed with the gate and never dirties the tree", async () => {
  const pidFile = join(logs, "bg.pid");
  const sh = `(sleep 1; echo late > late.txt) & echo $! > ${JSON.stringify(pidFile)}; exit 0`;
  const res = runGate(repo.dir, ["sh", "-c", sh], { tier: "full", logFile: log });
  assert.equal(res.exit, 0);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(alive(pid), false);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(existsSync(join(repo.dir, "late.txt")), false);
  assert.equal(git(repo.dir, "status", "--porcelain"), "");
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

// The contract's example gate: docs, tests, then the full fallback.
const DOCS = ["scripts/gate.sh", "--quick"];
const TESTS = ["scripts/gate.sh", "--tests"];
const FULL = ["scripts/gate.sh"];
const gateWith = (roles = {}, more = {}) => ({
  tiers: [
    { name: "docs", command: DOCS, when: { only: ["docs/**", "*.md"] } },
    { name: "tests", command: TESTS, when: { only: ["src/ui/**", "tests/**"] } },
    { name: "full", command: FULL },
  ],
  roles: { build: "pick", verify: "none", merge: "pick", ...roles },
  ...more,
});
const gate = gateWith();

test("pickTier: pick takes the first tier whose when holds, with its argv and the reason", () => {
  assert.deepEqual(pickTier(gate, "build", { changed: ["docs/a/b.md", "README.md", "x.md"] }), {
    tier: "docs",
    command: DOCS,
    reason: 'docs: every changed file (3) matches its "only"',
  });
  assert.equal(pickTier(gate, "merge", { changed: ["tests/a.mjs", "src/ui/b.tsx"] }).tier, "tests");
  assert.deepEqual(pickTier(gate, "build", { changed: ["src/a.ts"] }), {
    tier: "full",
    command: FULL,
    reason:
      'full: no earlier tier\'s "when" holds (docs: src/a.ts is outside its "only"; tests: src/a.ts is outside its "only")',
  });
});

test("pickTier: first match wins when two tiers' whens hold", () => {
  const both = {
    tiers: [
      { name: "a", command: ["a"], when: { any: ["src/**"] } },
      { name: "b", command: ["b"], when: { only: ["src/**"] } },
      { name: "full", command: ["f"] },
    ],
    roles: { build: "pick" },
  };
  assert.equal(pickTier(both, "build", { changed: ["src/x"] }).tier, "a");
  const swapped = { ...both, tiers: [both.tiers[1], both.tiers[0], both.tiers[2]] };
  assert.equal(pickTier(swapped, "build", { changed: ["src/x"] }).tier, "b");
});

test("pickTier: only, any and flag, alone and with no changed files", () => {
  const g = (when) => ({
    tiers: [
      { name: "t", command: ["t"], when },
      { name: "full", command: ["f"] },
    ],
    roles: { build: "pick" },
  });
  const tierOf = (when, facts) => pickTier(g(when), "build", facts).tier;
  // only: every changed file matches; none changed never matches.
  assert.equal(tierOf({ only: ["docs/**"] }, { changed: ["docs/a.md"] }), "t");
  assert.equal(tierOf({ only: ["docs/**"] }, { changed: ["docs/a.md", "src/b"] }), "full");
  assert.equal(tierOf({ only: ["docs/**"] }, { changed: [] }), "full");
  assert.match(pickTier(g({ only: ["d/**"] }), "build").reason, /no changed files for its "only"/);
  // any: some changed file matches; none changed never matches.
  assert.equal(tierOf({ any: ["src/ui/**"] }, { changed: ["a", "src/ui/b"] }), "t");
  assert.equal(tierOf({ any: ["src/ui/**"] }, { changed: ["a"] }), "full");
  assert.equal(tierOf({ any: ["src/ui/**"] }, { changed: [] }), "full");
  // flag: the item's flag, with or without changed files.
  assert.equal(tierOf({ flag: true }, { changed: [], flagged: true }), "t");
  assert.equal(tierOf({ flag: true }, { changed: ["a"], flagged: false }), "full");
  assert.match(
    pickTier(g({ flag: true }), "build", { flagged: true }).reason,
    /^t: the item is flagged$/,
  );
  // Any one condition is enough: no changed files, but flagged.
  assert.equal(tierOf({ only: ["docs/**"], flag: true }, { changed: [], flagged: true }), "t");
  assert.equal(tierOf({ any: ["x/**"], flag: true }, { changed: ["x/y"], flagged: false }), "t");
  assert.equal(tierOf({ any: ["x/**"], flag: true }, { changed: ["z"], flagged: false }), "full");
});

test("pickTier: each role value: pick, full, a tier name, none", () => {
  const docsOnly = { changed: ["docs/a.md"] };
  for (const role of ["build", "verify", "merge"]) {
    assert.equal(pickTier(gateWith({ [role]: "pick" }), role, docsOnly).tier, "docs", role);
    assert.deepEqual(pickTier(gateWith({ [role]: "full" }), role, docsOnly), {
      tier: "full",
      command: FULL,
      reason: `full: gate.roles.${role} is "full"`,
    });
    assert.deepEqual(pickTier(gateWith({ [role]: "tests" }), role, docsOnly), {
      tier: "tests",
      command: TESTS,
      reason: `tests: gate.roles.${role} is "tests"`,
    });
  }
  assert.deepEqual(pickTier(gate, "verify", docsOnly), {
    tier: null,
    command: null,
    reason: 'gate.roles.verify is "none"',
  });
  // `full` is the last tier, whatever it is called.
  const ci = { tiers: [{ name: "ci", command: ["c"] }], roles: { merge: "full" } };
  assert.equal(pickTier(ci, "merge").tier, "ci");
  assert.match(pickTier({ ...ci, roles: { merge: "pick" } }, "merge").reason, /only tier/);
});

test("checklistFor: items with no when, or whose when holds", () => {
  const g = gateWith(
    {},
    {
      checklist: [
        {
          name: "ui-smoke",
          text: "Open each changed screen",
          when: { any: ["src/ui/**"], flag: true },
        },
        { name: "owner-ok", text: "The owner saw it" },
        { name: "docs-read", text: "Read the docs", when: { only: ["docs/**"] } },
      ],
    },
  );
  const names = (facts) => checklistFor(g, facts).map((i) => i.name);
  assert.deepEqual(checklistFor(g, { changed: ["src/ui/a.tsx"] }), [
    { name: "ui-smoke", text: "Open each changed screen" },
    { name: "owner-ok", text: "The owner saw it" },
  ]);
  assert.deepEqual(names({ changed: ["src/a.ts"] }), ["owner-ok"]);
  assert.deepEqual(names({ changed: [], flagged: true }), ["ui-smoke", "owner-ok"]);
  assert.deepEqual(names({ changed: ["docs/a.md"] }), ["owner-ok", "docs-read"]);
  assert.deepEqual(checklistFor({ tiers: [] }, {}), []);
});

test("globMatch: * and ? stay in one folder, ** crosses folders, case counts", () => {
  assert.equal(globMatch(["*.md"], "README.md"), true);
  assert.equal(globMatch(["*.md"], "docs/a.md"), false);
  assert.equal(globMatch(["docs/**"], "docs/a/b.md"), true);
  assert.equal(globMatch(["docs/**"], "Docs/a.md"), false);
  assert.equal(globMatch(["a?.md"], "ab.md"), true);
  assert.equal(globMatch(["a?.md"], "a/.md"), false);
  assert.equal(globMatch([], "a.md"), false);
  assert.equal(globMatch(["x", "docs/**"], "docs/y"), true);
});

test("a rename out of docs/ lists both paths, so it is never docs-only", () => {
  commitFile(repo.dir, "docs/a.md", "a\n".repeat(20));
  const before = git(repo.dir, "rev-parse", "HEAD");
  mkdirSync(join(repo.dir, "src"));
  git(repo.dir, "mv", "docs/a.md", "src/a.txt");
  git(repo.dir, "commit", "-q", "-m", "move");
  const changed = changedSince(repo.dir, before);
  assert.deepEqual(changed.sort(), ["docs/a.md", "src/a.txt"]);
  assert.equal(pickTier(gateWith({ build: "pick" }, {}), "build", { changed }).tier, "full");
});

test("globs: ** never crosses a .. segment or a partial segment, and odd paths never match", () => {
  const only = (glob, file) => globMatch([glob], file);
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

const record = {
  exit: 0,
  role: "build",
  tier: "full",
  command: FULL,
  cleanBefore: true,
  cleanAfter: true,
  tree: "t1",
};
const ok = {
  record,
  need: { tier: "full", command: FULL },
  mainTree: "t1",
  branchTipTree: "t1",
  changedSinceGate: [],
  after: ["docs/**"],
};

test("canSkip: skips under all four conditions, including post-gate docs", () => {
  assert.equal(canSkip(ok).skip, true);
  assert.equal(canSkip({ ...ok, changedSinceGate: ["docs/x.md"] }).skip, true);
});

test("canSkip: the record's tier and argv must be the land's", () => {
  const tests = { ...record, tier: "tests", command: TESTS };
  assert.deepEqual(canSkip({ ...ok, record: tests }), {
    skip: false,
    reason: "the recorded gate ran tests, the land needs full",
  });
  assert.equal(
    canSkip({ ...ok, record: tests, need: { tier: "tests", command: TESTS } }).skip,
    true,
  );
  const edited = { ...ok, need: { tier: "full", command: ["scripts/gate.sh", "--all"] } };
  assert.deepEqual(canSkip(edited), {
    skip: false,
    reason: "the full tier's command changed since the gate ran",
  });
  const longer = { ...ok, need: { tier: "full", command: [...FULL, "--x"] } };
  assert.match(canSkip(longer).reason, /full tier's command changed/);
  // A record from before tiers (no command, or the old quick tier) never skips.
  for (const old of [
    { ...record, command: undefined },
    { ...record, tier: "quick", command: undefined },
  ])
    assert.match(
      canSkip({ ...ok, record: old }).reason,
      /has no command: it ran before gate tiers/,
    );
  assert.equal(canSkip({ ...ok, record: { ...record, tier: "quick" } }).skip, false);
  assert.match(canSkip({ ...ok, need: { tier: null, command: null } }).reason, /needs no tier/);
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

test("changedSince takes a SHA or a ref and refuses anything git could read as an option", () => {
  const gated = commitFile(repo.dir, "a.txt", "a\n");
  commitFile(repo.dir, "b.txt", "b\n");
  assert.deepEqual(changedSince(repo.dir, gated), ["b.txt"]);
  assert.deepEqual(changedSince(repo.dir, "HEAD~1", "main"), ["b.txt"]);
  const out = join(logs, "injected.txt");
  assert.equal(changedSince(repo.dir, `--output=${out}`), null);
  assert.equal(changedSince(repo.dir, gated, `--output=${out}`), null);
  assert.equal(changedSince(repo.dir, "--no-index"), null);
  assert.equal(changedSince(repo.dir, undefined), null);
  assert.equal(existsSync(out), false);
});

test("canSkip: cleanBefore and cleanAfter must be literally true", () => {
  for (const flag of ["yes", 1, {}, "false"])
    for (const key of ["cleanBefore", "cleanAfter"]) {
      const res = canSkip({ ...ok, record: { ...record, [key]: flag } });
      assert.equal(res.skip, false, `${key}=${JSON.stringify(flag)}`);
      assert.match(res.reason, /clean tree/);
    }
});

test("canSkip: an after that is not a list of globs refuses with a reason instead of throwing", () => {
  for (const after of ["docs/**", {}, 5, [1], ["docs/**", null]]) {
    const res = canSkip({ ...ok, after });
    assert.equal(res.skip, false, JSON.stringify(after));
    assert.match(res.reason, /"after"/);
  }
});

test("canSkip: each failed condition refuses with its own reason", () => {
  const cases = [
    [{ ...ok, record: null }, /no gate record/],
    [{ ...ok, record: { ...record, exit: 1 } }, /exited 1/],
    [{ ...ok, record: { ...record, exit: 1, tier: "tests" } }, /exited 1/],
    [{ ...ok, record: { ...record, tier: "quick" } }, /ran quick, the land needs full/],
    [{ ...ok, record: { ...record, tier: undefined } }, /ran an unknown tier, the land needs full/],
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

// A gate log on disk, then what `flakyReds` makes of it.
const logWith = (text) => {
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, text);
  return log;
};

test("flakyReds names the listed tests when every failure line is one of them", () => {
  const file = logWith(
    "ok a\nFAILED test_budget (710 ms > 700)\nFAILED test_path_quarter\n2 failed\n",
  );
  assert.deepEqual(flakyReds(file, ["test_budget", "test_path_quarter"]), [
    "test_budget",
    "test_path_quarter",
  ]);
});

test("flakyReds is null when any failure is unlisted, none is readable, or nothing is listed", () => {
  const mixed = logWith("FAILED test_budget\nFAILED test_real_bug\n");
  assert.equal(flakyReds(mixed, ["test_budget"]), null);
  const silent = logWith("the build exploded\n");
  assert.equal(flakyReds(silent, ["test_budget"]), null);
  const listed = logWith("FAILED test_budget\n");
  assert.equal(flakyReds(listed, []), null);
  assert.equal(flakyReds(listed, undefined), null);
  assert.equal(flakyReds(join(logs, "missing.log"), ["test_budget"]), null);
});

// A step log beside the gate's own, matched by a flakyLogs glob from `logs`.
const stepLog = (text) => {
  writeFileSync(join(logs, "step.log"), text);
  return { logs: ["step.log"], cwd: logs };
};
const SUMMARY_ONLY = "the run failed: see the step logs\n";

test("flakyReds reads FAILED <name>, <path>::<test> and JSON test lines, in the own log and a flakyLogs file", () => {
  const forms = [
    ["FAILED tests/test_a.py::test_b - AssertionError\n", "tests/test_a.py::test_b", "test_b"],
    ["FAILED tests/a.py::test_b[x-1] - E\n", "tests/a.py::test_b[x-1]", "tests/a.py::test_b[x-1]"],
    ["tests/a.py::test_c ERROR [ 50%]\n", "tests/a.py::test_c", "tests/a.py::test_c"],
    ['{"test":"t","status":"FAILED"}\n', "t", "t"],
    ['{"test": "t2", "outcome": "failure"}\n', "t2", "t2"],
    ['{"test":"t3","result":"Error","ms":3}\n', "t3", "t3"],
    ['{"event":"fail","test":"t4"}\n', "t4", "t4"],
  ];
  for (const [line, , listed] of forms) {
    assert.deepEqual(
      flakyReds(logWith(`ok a\n${line}1 failed\n`), [listed]),
      [listed],
      `own: ${line}`,
    );
    const extra = stepLog(`ok a\n${line}`);
    assert.deepEqual(flakyReds(logWith(SUMMARY_ONLY), [listed], extra), [listed], `step: ${line}`);
  }
  // An unlisted test in the same forms stays a real red.
  assert.equal(flakyReds(logWith("FAILED other_test - E\n"), ["test_budget"]), null);
  const unlisted = stepLog("FAILED other_test - E\nFAILED test_budget\n");
  assert.equal(flakyReds(logWith(SUMMARY_ONLY), ["test_budget"], unlisted), null);
  assert.equal(flakyReds(logWith('{"test":"other","status":"failed"}\n'), ["t"]), null);
});

test("flakyReds: summaries, passing JSON lines and cut JSON name no failure", () => {
  for (const line of [
    "FAILED",
    "0 FAILED",
    "FAILED: 2",
    "2 failed, 10 passed",
    "== 1 failed in 3s ==",
  ]) {
    const extra = stepLog(`${line}\n`);
    assert.equal(flakyReds(logWith(SUMMARY_ONLY), ["x"], extra), null, line);
  }
  for (const line of [
    '{"test":"t","status":"passed"}',
    '[{"test":"t"}]',
    '{"test":',
    '{"test":"t"}',
  ]) {
    // In the own log, such a line is no failure line, so the step log decides (and names t failing).
    const extra = stepLog('{"test":"t","status":"failed"}\n');
    assert.deepEqual(flakyReds(logWith(`${line}\n`), ["t"], extra), ["t"], line);
    assert.equal(flakyReds(logWith(SUMMARY_ONLY), ["t"], stepLog(`${line}\n`)), null, line);
  }
});

test("flakyReds: a listed name counts only whole, and a CRLF log reads as LF", () => {
  assert.equal(flakyReds(logWith("FAILED test_slow_case\n"), ["test_slow"]), null);
  assert.equal(flakyReds(logWith("FAIL test_slow_case (1 s)\n"), ["test_slow"]), null);
  assert.deepEqual(flakyReds(logWith("FAILED test_slow (1 s)\n"), ["test_slow"]), ["test_slow"]);
  const crlf = 'ok a\r\nFAILED test_budget\r\n{"test":"t","status":"failed"}\r\n1 failed\r\n';
  assert.deepEqual(flakyReds(logWith(crlf), ["test_budget", "t"]), ["test_budget", "t"]);
  const extra = stepLog('{"test":"t","status":"failed"}\r\n');
  assert.deepEqual(flakyReds(logWith(SUMMARY_ONLY.replace("\n", "\r\n")), ["t"], extra), ["t"]);
});

// A real `lane exec gate` on a scratch board whose gate command backgrounds a child: `{ root, run, pids }`,
// once the gate runs and (unless `settle` is false) its slot is settled (`pids` the command and its child,
// `run` the gate's own process). Its process waits for the gate synchronously, so it can clean nothing up
// itself on a signal: its watchdog has to.
async function gateRunning(marker, { settle = true } = {}) {
  const { writeSpec } = await import("./spec-files.mjs");
  const lane = join(dirname(new URL(import.meta.url).pathname), "..", "lane.mjs");
  const root = repo.dir;
  const env = { ...gitEnv, HOME: logs };
  const spec = {
    version: 1,
    name: "Exec",
    root: "plan",
    kinds: {
      sprint: {
        label: "Sprint",
        at: { table: "BOARD.md", heading: "Sprints" },
        id: { column: "Sprint" },
        fields: { status: { column: "Status" } },
        status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      },
      task: {
        label: "Task",
        at: { table: "BOARD.md", heading: "Tasks" },
        id: { column: "Task" },
        fields: {
          sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
          status: { column: "Status" },
          verdict: { column: "Verdict" },
          commit: { column: "Commit", type: "commits" },
        },
        status: {
          field: "status",
          values: { todo: "planned", doing: "active", verify: "active", done: "done" },
        },
        contract: { blocks: ["TASKS.md"] },
      },
    },
    rules: [{ rule: "ids-unique" }, { rule: "status-known" }],
    lifecycle: {
      kind: "task",
      on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
      write: { status: "status", verdict: "verdict", commit: "commit" },
    },
    gate: {
      roles: { verify: "pick" },
      tiers: [
        {
          name: "full",
          command: ["sh", "-c", `echo $$ > ${marker}; sleep 40 & echo $! >> ${marker}; wait`],
        },
      ],
    },
  };
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(
    root,
    "plan/BOARD.md",
    "# Exec\n\n## Sprints\n\n| Sprint | Status |\n| ------ | ------ |\n| S1     | doing  |\n\n## Tasks\n\n| Task | Sprint | Status | Verdict | Commit |\n| ---- | ------ | ------ | ------- | ------ |\n| T1   | S1     | todo   |         |        |\n",
  );
  commitFile(
    root,
    "plan/TASKS.md",
    "# Tasks\n\n- **T1** (S1): owns `out.txt`. Accept: out.txt exists.\n",
  );
  writeSpec(join(root, ".agentry"), spec);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "process");
  const exec = (...args) =>
    JSON.parse(
      spawnSync(process.execPath, [lane, "exec", ...args, "--json", "--root", root], {
        encoding: "utf8",
        env,
      }).stdout,
    );
  const started = exec("start", "T1");
  commitFile(started.worktree, "out.txt", "made\n", "feat: add out.txt");
  writeFileSync(started.reportPath, "DONE\nadded\nused_memories: none\n");
  exec("report", "T1");
  const run = spawn(process.execPath, [lane, "exec", "gate", "T1", "--json", "--root", root], {
    env,
    stdio: "ignore",
  });
  const lines = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : []);
  // A fine poll: unsettled, the caller wants the moment the command is up.
  const up = Date.now() + 15000;
  while (lines().length < 2 && Date.now() < up) await new Promise((r) => setTimeout(r, 2));
  if (!settle) return { root, run, pids: lines().map(Number) };
  // The watchdog records the command's group in the slot (`recordGroup`) only once the command runs, so
  // under load the command can be up while that write is still in flight (its mutex and temp file beside
  // the slot). Wait for it to settle: the group recorded, nothing beside the slot.
  const slots = join(root, ".agentry", "run", "gate-locks");
  const settled = () => {
    try {
      const recorded = JSON.parse(readFileSync(join(slots, "slot-1.lock"), "utf8")).pgid;
      return Number.isInteger(recorded) && readdirSync(slots).join() === "slot-1.lock";
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 200 && !settled(); i++) await new Promise((r) => setTimeout(r, 25));
  return { root, run, pids: lines().map(Number) };
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"])
  test(`${signal} of lane exec gate mid-gate takes the gate command down and leaves gate-locks empty within 3 s`, async () => {
    const { root, run, pids } = await gateRunning(join(logs, "gate.pids"));
    assert.equal(pids.length, 2, "the gate command and its child run");
    const slots = join(root, ".agentry", "run", "gate-locks");
    assert.deepEqual(readdirSync(slots), ["slot-1.lock"]);
    const gone = new Promise((resolve) => run.on("exit", resolve));
    run.kill(signal);
    await gone;
    const killed = Date.now();
    const clean = () => !pids.some(alive) && readdirSync(slots).length === 0;
    while (!clean() && Date.now() - killed < 3000) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(pids.filter(alive), [], "no gate process outlived its holder");
    assert.deepEqual(
      readdirSync(slots),
      [],
      "no slot, mutex or temp file left, nothing cleared first",
    );
  });

// The same signals the moment the gate command is up, with no settle: under load they often land while the
// watchdog's `recordGroup` write is still in flight (its mutex and temp file beside the slot). Wherever one
// lands, nothing may be left once the gate process is gone.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"])
  test(`${signal} of lane exec gate as its watchdog records the group: gate-locks is empty within 3 s`, async () => {
    const { root, run, pids } = await gateRunning(join(logs, "gate.pids"), { settle: false });
    try {
      assert.equal(pids.length, 2, "the gate command and its child run");
      const slots = join(root, ".agentry", "run", "gate-locks");
      const gone = new Promise((resolve) => run.on("exit", resolve));
      run.kill(signal);
      await gone;
      const killed = Date.now();
      const clean = () => !pids.some(alive) && readdirSync(slots).length === 0;
      while (!clean() && Date.now() - killed < 3000) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(pids.filter(alive), [], "no gate process outlived its holder");
      assert.deepEqual(readdirSync(slots), [], "no slot, mutex or temp file left");
    } finally {
      killAll([...pids, run.pid]);
    }
  });

for (const signal of ["SIGPIPE", "SIGUSR1"])
  test(`a gate command killed by ${signal} (a signal the watchdog cannot die of) is logged as killed by it, and is red`, () => {
    const res = runGate(repo.dir, ["sh", "-c", `kill -${signal.slice(3)} $$`], {
      tier: "full",
      logFile: log,
    });
    assert.notEqual(res.exit, 0);
    assert.match(readFileSync(log, "utf8"), new RegExp(`sh was killed by ${signal}`));
  });

// The watchdog of a running gate: the gate command's parent, checked to be supervise.mjs.
function watchdogOf(pids) {
  const watchdog = Number(
    spawnSync("ps", ["-o", "ppid=", "-p", String(pids[0])], { encoding: "utf8" }).stdout.trim(),
  );
  assert.match(
    spawnSync("ps", ["-ww", "-o", "command=", "-p", String(watchdog)], { encoding: "utf8" }).stdout,
    /supervise\.mjs --parent/,
  );
  return watchdog;
}
// SIGKILL each pid, whatever the test's outcome: a red run must not leave its gate command running.
const killAll = (pids) => {
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
};

// The gate's watchdog itself killed (by -9, or by a signal it has no handler for) while the gate runs.
for (const signal of ["SIGKILL", "SIGHUP", "SIGINT", "SIGTERM"])
  test(`${signal} of the gate's watchdog alone: once lane exec gate returns, no gate process runs and gate-locks is empty`, async () => {
    const { root, run, pids } = await gateRunning(join(logs, "gate.pids"));
    try {
      assert.equal(pids.length, 2, "the gate command and its child run");
      const watchdog = watchdogOf(pids);
      const returned = new Promise((resolve) => run.on("exit", resolve));
      process.kill(watchdog, signal);
      await returned;
      const back = Date.now();
      // Reaped once re-parented: a moment, never a second gate's worth of time.
      while (pids.some(alive) && Date.now() - back < 500)
        await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(pids.filter(alive), [], "a gate process outlived its gate");
      assert.deepEqual(readdirSync(join(root, ".agentry", "run", "gate-locks")), []);
    } finally {
      killAll([...pids, run.pid]); // R1d-37 r7 N19: a red run left its sleep 40 running
    }
  });

// R1d-37 r7 N17 (probe p15): the gate process and its watchdog SIGKILLed at once left the gate command
// running, its slot read free, and the sweep freed it without stopping the command.
test("SIGKILL of lane exec gate and its watchdog together: the slot holds for the command's group, and the sweep stops it", async () => {
  const lane = join(dirname(new URL(import.meta.url).pathname), "..", "lane.mjs");
  const { root, run, pids } = await gateRunning(join(logs, "gate.pids"));
  try {
    assert.equal(pids.length, 2, "the gate command and its child run");
    const watchdog = watchdogOf(pids);
    const slot = join(root, ".agentry", "run", "gate-locks", "slot-1.lock");
    const recorded = () => JSON.parse(readFileSync(slot, "utf8")).pgid;
    for (let i = 0; i < 100 && recorded() !== watchdog; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(recorded(), watchdog, "the slot records the watchdog's group");
    const returned = new Promise((resolve) => run.on("exit", resolve));
    process.kill(run.pid, "SIGKILL");
    process.kill(watchdog, "SIGKILL");
    await returned;
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(pids.filter(alive), pids, "nothing was left to stop the command");
    const { heldSlots } = await import("../lib/lane/gate-lock.mjs");
    assert.deepEqual(
      heldSlots(join(root, ".agentry", "run", "gate-locks")).map((h) => h.slot),
      [1],
      "a next gate waits: the slot is held while the group runs",
    );
    const swept = spawnSync(process.execPath, [lane, "sweep", "--apply", "--root", root], {
      encoding: "utf8",
      env: { ...gitEnv, HOME: logs },
    });
    assert.equal(swept.status, 0, swept.stdout + swept.stderr);
    assert.match(
      swept.stdout,
      new RegExp(`freed gate slot 1: its holder is gone\\n {4}group ${watchdog} stopped`),
    );
    assert.deepEqual(pids.filter(alive), [], "the sweep stopped the gate command's group");
    assert.deepEqual(readdirSync(join(root, ".agentry", "run", "gate-locks")), []);
  } finally {
    killAll([...pids, run.pid]);
  }
});
