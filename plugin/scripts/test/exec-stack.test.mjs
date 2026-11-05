// Tests for stacked exec lanes end to end on temp git repos: `lane exec start T2 --on T1` cuts T2 from
// T1's tip and refuses what it cannot stack on; T2's steps say what is due when T1 moves; its gate refuses
// until `restack`, which runs only with no agent out; a conflict leaves everything as it was, a hand
// resolution gets the resolution recheck; show and the episode name the stack. Builders and verifiers are
// simulated by committing in the worktree and writing their report files.
// Run: node --test plugin/scripts/test/exec-stack.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
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
  name: "Stack",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
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
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "true"] }] },
};
const BOARD_MD = `# Stack

## Tasks

| Task | Status | Verdict | Commit |
| ---- | ------ | ------- | ------ |
| T1   | todo   |         |        |
| T2   | todo   |         |        |
| T3   | todo   |         |        |
`;
const TASKS_MD = `# Tasks

- **T1**: owns \`shared.txt\`, \`one.txt\`. Accept: one.txt exists.
- **T2**: owns \`shared.txt\`, \`two.txt\`. Accept: two.txt exists.
- **T3**: owns \`two.txt\`, \`three.txt\`. Accept: three.txt exists.
`;

function repo(config, spec = SPEC) {
  const root = temp("exec-stack-repo-");
  const home = temp("exec-stack-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  if (config) writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify(config));
  commitFile(root, ".gitignore", ".agentry/run/\n.agentry/config.json\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "shared.txt", "a\nb\nc\n");
  writeSpec(join(root, ".agentry"), spec);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  return { root, home };
}
const run = ({ root, home }, cli, args) =>
  spawnSync("node", [LANE, cli, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
function lane(r, ...args) {
  const res = run(r, "exec", [...args, "--json"]);
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { exit: res.status, json, out: res.stdout + res.stderr };
}
const text = (r, ...args) => run(r, "exec", args).stdout;
const merge = (r, ...args) => run(r, "merge", args);
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const tipOf = (root, ref) => git(root, "rev-parse", ref);
const short = (sha) => sha.slice(0, 7);

// A builder's work: commit `file` (with `body`) in the worktree, write the report.
function build(out, file, body = "made\n") {
  // Dated in the past: landed in the same second, with the same parent, author and message, the pick
  // would be the very same commit and main's copy of it no new commit.
  gitEnv.GIT_COMMITTER_DATE = "2020-01-01T00:00:00Z";
  try {
    commitFile(out.worktree, file, body, `feat: ${file}`);
  } finally {
    // biome-ignore lint/performance/noDelete: an env var set to undefined is the string "undefined"
    delete gitEnv.GIT_COMMITTER_DATE;
  }
  writeFileSync(out.reportPath, `DONE\nadded ${file}\nused_memories: none\n`);
}
const judge = (out, verdict, notes = "") =>
  writeFileSync(
    out.reportPath,
    `All acceptance items checked.\n${notes}used_memories: none\nVerdict: ${verdict}\n`,
  );
// Lane `id` from start to a verified close, its builder adding `file` (`verdict` its one verdict); with
// `close: false` it stops at close next, its gate green.
function verified(r, id, file, { body, verdict = "PASS", notes = "", on, close = true } = {}) {
  let out = lane(r, "start", id, ...(on ? ["--on", on] : [])).json;
  build(out, file, body);
  out = lane(r, "report", id).json;
  judge(out, verdict, notes);
  assert.equal(lane(r, "verdict", id).json.next, "gate");
  assert.equal(lane(r, "gate", id).exit, 0);
  if (close) assert.equal(lane(r, "close", id).exit, 0);
}
// What a refused step must leave as it was: the branches, the worktrees, every ledger's bytes.
function state(root) {
  const dir = join(root, ".agentry", "run", "process", "ledger");
  return {
    branches: git(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
    worktrees: git(root, "worktree", "list", "--porcelain"),
    ledgers: existsSync(dir)
      ? Object.fromEntries(
          spawnSync("ls", [dir], { encoding: "utf8" })
            .stdout.split("\n")
            .filter(Boolean)
            .map((f) => [f, readFileSync(join(dir, f), "utf8")]),
        )
      : {},
  };
}

test("start T2 --on T1 cuts from T1's tip, keeps on and base, and says it shares files with T1", () => {
  const r = repo();
  verified(r, "T1", "shared.txt", { body: "a\nT1\nc\n" });
  const t1 = tipOf(r.root, "agentry/T1");
  // An unrelated running lane that owns a file T2 owns too.
  lane(r, "start", "T3");
  const res = lane(r, "start", "T2", "--on", "t1");
  assert.equal(res.exit, 0, res.out);
  assert.equal(tipOf(r.root, "agentry/T2"), t1, "cut from T1's tip");
  const ledger = ledgerOf(r.root, "T2");
  assert.deepEqual([ledger.on, ledger.base], ["T1", t1]);
  assert.equal(ledger.mainAtStart.head, tipOf(r.root, "main"), "main at start is main's");
  assert.equal(res.json.stack, `on T1 at ${short(t1)} (T1 is verified); T1 lands first`);
  const warnings = res.json.warning.split("\n");
  assert.deepEqual(
    warnings.filter((w) => w.startsWith("stack:")),
    ["stack: shares with T1: shared.txt"],
  );
  assert.ok(warnings.includes("! owns overlap with T3: two.txt"), res.json.warning);
  assert.ok(
    !warnings.some((w) => w.includes("overlap with T1")),
    "no overlap warning for the parent",
  );
  // The readable form puts the stack line right after the header.
  const shown = text(r, "show", "T2").split("\n");
  assert.equal(shown[1], `stack: on T1 at ${short(t1)}`);
});

test("--on refusals, each exit 2 with branches, worktrees and ledgers unchanged", () => {
  const r = repo();
  const refused = (args, pattern) => {
    const before = state(r.root);
    const res = lane(r, ...args);
    assert.equal(res.exit, 2, res.out);
    assert.match(res.out, pattern);
    assert.deepEqual(state(r.root), before, args.join(" "));
  };
  refused(["start", "T2", "--on", "t2"], /✗ lane exec start T2: --on names the task itself$/m);
  refused(
    ["start", "T2", "--on", "T1"],
    new RegExp(
      `✗ lane exec start T2: no lane for T1: start it first \\(node '${LANE}' exec start T1 --root '${r.root}'\\)$`,
      "m",
    ),
  );
  lane(r, "start", "T1");
  refused(
    ["start", "T2", "--on", "T1"],
    /✗ lane exec start T2: T1 is building: stack on it once it is verified, held or at its gate$/m,
  );
  refused(["report", "T1", "--on", "T3"], /--on goes with start only/);
  // A verifier out on T1: not at its gate yet.
  const out = ledgerOf(r.root, "T1");
  build({ worktree: out.worktree, reportPath: out.rounds[0].reportPath }, "one.txt");
  lane(r, "report", "T1");
  refused(
    ["start", "T2", "--on", "T1"],
    /✗ lane exec start T2: T1 is verifying \(next verify\): stack on a lane that is verified, held or at its gate$/m,
  );
  const merged = { ...ledgerOf(r.root, "T1"), state: "merged", next: null };
  writeFileSync(ledgerFile(r.root, "T1"), JSON.stringify(merged));
  refused(
    ["start", "T2", "--on", "T1"],
    /✗ lane exec start T2: T1 is merged: start T2 without --on \(main holds it\)$/m,
  );
});

test("at lanes.maxWriters 1, T2 starts on a verified T1 and T3 is refused naming T2", () => {
  const r = repo({ lanes: { maxWriters: 1 } });
  verified(r, "T1", "one.txt");
  assert.equal(lane(r, "start", "T2", "--on", "T1").exit, 0);
  const res = lane(r, "start", "T3");
  assert.equal(res.exit, 2);
  assert.match(res.out, /1 writer\(s\) open, lanes\.maxWriters is 1/);
  assert.match(res.out, /T2 \(building, ledger /);
  assert.doesNotMatch(res.out, /T1 \(/);
});

test("T1 moves under T2: T2's steps go on and print the due line, its gate waits for the restack", () => {
  const r = repo();
  verified(r, "T1", "one.txt", {
    verdict: "PASS WITH NOTES",
    notes: "N1 tidy the file\n",
    close: false,
  });
  const t1 = tipOf(r.root, "agentry/T1");
  let t2 = lane(r, "start", "T2", "--on", "T1").json;
  build(t2, "two.txt");
  // A notes fix on T1 moves its tip while T2's builder is out.
  const fix = lane(r, "fix", "T1", "--notes", "N1").json;
  build(fix, "one.txt", "tidied\n");
  assert.equal(lane(r, "report", "T1").exit, 0);
  const moved = tipOf(r.root, "agentry/T1");
  const due = `on T1 at ${short(t1)}; T1 moved to ${short(moved)} → node '${LANE}' exec restack T2 --root '${r.root}'`;
  t2 = lane(r, "report", "T2");
  assert.equal(t2.exit, 0, t2.out);
  assert.equal(t2.json.stack, due);
  assert.equal(t2.json.next, "verify");
  // The verify brief judges only T2's own commits.
  const brief = readFileSync(t2.json.brief, "utf8");
  assert.match(brief, new RegExp(`git diff --stat ${short(t1)}\\.\\.HEAD`));
  assert.match(
    brief.replace(/\s+/g, " "),
    new RegExp(
      `This branch is stacked on T1: it was cut from agentry/T1 at ${short(t1)}\\. Judge \\(or build\\) only ${short(t1)}\\.\\.HEAD; T1's commits are its own lane's\\. Never rebase: the lane restacks\\.`,
    ),
  );
  // No restack while T2's verifier reads.
  const out = lane(r, "restack", "T2");
  assert.equal(out.exit, 2);
  assert.match(
    out.out,
    /a verify round is out \(round 2, next verify\): restack when the lane is at its gate, close or merge, or held/,
  );
  judge(t2.json, "PASS");
  const verdict = lane(r, "verdict", "T2");
  assert.deepEqual([verdict.json.next, verdict.json.stack], ["gate", due]);
  const before = state(r.root);
  const gate = lane(r, "gate", "T2");
  assert.equal(gate.exit, 2);
  assert.equal(
    gate.out.trim(),
    `✗ lane exec gate T2: T1 moved since T2 was cut on it (${short(t1)} → ${short(moved)}): a gate here would not count → node '${LANE}' exec restack T2 --root '${r.root}'`,
  );
  assert.deepEqual(state(r.root), before);
  // At its gate, the restack replays T2 onto T1's tip; the gate then closes it with no verifier added.
  const rounds = ledgerOf(r.root, "T2").rounds.length;
  const restacked = lane(r, "restack", "T2");
  assert.equal(restacked.exit, 0, restacked.out);
  assert.equal(restacked.json.next, "gate");
  assert.equal(tipOf(r.root, "agentry/T2^"), moved);
  // T1 moves again before T2's gate: refused again, with the new shas.
  const again = commitFile(ledgerOf(r.root, "T1").worktree, "one.txt", "again\n", "fix: again");
  assert.match(
    lane(r, "gate", "T2").out,
    new RegExp(`T1 moved since T2 was cut on it \\(${short(moved)} → ${short(again)}\\)`),
  );
  assert.equal(lane(r, "restack", "T2").exit, 0);
  const gated = lane(r, "gate", "T2");
  assert.equal(gated.exit, 0, gated.out);
  assert.equal(gated.json.next, "close");
  const ledger = ledgerOf(r.root, "T2");
  assert.equal(ledger.rounds.length, rounds, "no verifier round added");
  assert.equal(ledger.closedTip, tipOf(r.root, "agentry/T2"));
  // show names the stack and each restack; the episode counts them.
  const shown = lane(r, "show", "T2").json;
  assert.equal(shown.stack, `on T1 at ${short(again)}`);
  assert.equal(shown.restacks.split("\n").length, 2);
  assert.match(
    shown.restacks.split("\n")[0],
    new RegExp(
      `^onto T1 at ${short(moved)} \\(was ${short(t1)}\\): tip \\w{7} → \\w{7}, no conflict · `,
    ),
  );
  assert.equal(lane(r, "show", "T1").json["stacked on it"], "T2");
  const closed = lane(r, "close", "T2").json;
  assert.match(closed.episode.outcome, /; stacked on T1; restacks: 2(;|$)/);
});

test("a conflicting T1 change: the restack stops with nothing changed; resolved by hand, it is rechecked", () => {
  const r = repo();
  verified(r, "T1", "one.txt");
  const t1 = tipOf(r.root, "agentry/T1");
  verified(r, "T2", "shared.txt", { body: "a\nT2\nc\n", on: "T1" });
  const t2 = ledgerOf(r.root, "T2");
  const fixed = commitFile(ledgerOf(r.root, "T1").worktree, "shared.txt", "a\nT1\nc\n", "fix: b");
  const before = state(r.root);
  const stopped = lane(r, "restack", "T2");
  assert.equal(stopped.exit, 1, stopped.out);
  assert.match(
    stopped.out,
    new RegExp(
      `^✗ lane exec restack T2: ${short(t2.closedTip)} feat: shared\\.txt conflicts on agentry/T1 at ${short(fixed)} \\(shared\\.txt\\): aborted, agentry/T2 is back at ${short(t2.closedTip)} → resolve it in ${t2.worktree}: git rebase --onto agentry/T1 ${short(t1)}, then `,
    ),
  );
  assert.deepEqual(state(r.root), before);
  assert.equal(git(t2.worktree, "status", "--porcelain"), "");
  // The owner resolves it by hand in the worktree.
  const env = { ...gitEnv, GIT_EDITOR: "true" };
  spawnSync("git", ["-C", t2.worktree, "rebase", "--onto", "agentry/T1", t1], { env });
  writeFileSync(join(t2.worktree, "shared.txt"), "a\nT1 and T2\nc\n");
  git(t2.worktree, "add", "shared.txt");
  const done = spawnSync("git", ["-C", t2.worktree, "rebase", "--continue"], { env });
  assert.equal(done.status, 0, String(done.stderr));
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  assert.match(res.json.restacked, /resolved by hand/);
  assert.deepEqual([res.json.next, res.json.role, res.json.mode], ["resolve", "verify", "fresh"]);
  const entry = ledgerOf(r.root, "T2").restacks.at(-1);
  assert.equal(entry.resolution, "by hand");
  assert.match(readFileSync(res.json.brief, "utf8"), new RegExp(entry.rangeDiff));
  judge(res.json, "PASS");
  assert.equal(lane(r, "verdict", "T2").json.next, "gate");
  assert.equal(lane(r, "gate", "T2").json.next, "close");
});

test("T2's report after T1's land and board commit trips no main-touched guard", () => {
  const r = repo();
  verified(r, "T1", "one.txt");
  const t2 = lane(r, "start", "T2", "--on", "T1").json;
  build(t2, "two.txt");
  const land = merge(r, "T1", "--message", "chore(board): land T1");
  assert.equal(land.status, 0, land.stdout + land.stderr);
  // T2's builder is out: T1's land leaves it as it is and names it.
  assert.match(land.stdout, /! stack {3}T2 is stacked on T1: lane exec restack T2 before its gate/);
  const res = lane(r, "report", "T2");
  assert.equal(res.exit, 0, res.out);
  assert.deepEqual(res.json.guards, []);
  assert.equal(res.json.next, "verify");
  assert.match(res.json.stack, /; T1 landed → .*exec restack T2 --root /);
});

// ---- a gate already in flight -------------------------------------------------------

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Another lane's process holding gate slot 1 until it is killed.
function holdSlot(root) {
  const holder = spawn("sleep", ["60"], { stdio: "ignore" });
  const locks = join(root, ".agentry", "run", "gate-locks");
  mkdirSync(locks, { recursive: true });
  writeFileSync(
    join(locks, "slot-1.lock"),
    JSON.stringify({ pid: holder.pid, who: "lane OTHER", at: new Date().toISOString() }),
  );
  return holder;
}
// `lane exec gate <id>` started in the background; resolves to its exit code. Returns once its log says it
// waits for the slot.
function queuedGate({ root, home }, id) {
  const child = spawn("node", [LANE, "exec", "gate", id, "--json", "--root", root], {
    env: { ...gitEnv, HOME: home },
    stdio: "ignore",
  });
  const exited = new Promise((done) => child.on("exit", done));
  const log = join(root, ".agentry", "run", "process", "runs", id, "logs", "gate-1.log");
  for (
    let i = 0;
    i < 200 && !(existsSync(log) && readFileSync(log, "utf8").includes("waiting"));
    i++
  )
    pause(50);
  assert.match(readFileSync(log, "utf8"), /waiting for gate slot 1/);
  return exited;
}

test("a restack is refused while the lane's gate is queued, and the gate's write never undoes a restack", async () => {
  const r = repo();
  verified(r, "T1", "one.txt");
  const t2 = toGate(r);
  const holder = holdSlot(r.root);
  const gated = queuedGate(r, "T2");
  const moved = commitFile(ledgerOf(r.root, "T1").worktree, "one.txt", "moved\n", "fix: move T1");
  const before = readFileSync(ledgerFile(r.root, "T2"), "utf8");
  const refused = lane(r, "restack", "T2");
  assert.equal(refused.exit, 2, refused.out);
  assert.match(
    refused.out,
    /✗ lane exec restack T2: a gate for T2 is queued or running: restack after it$/m,
  );
  assert.equal(readFileSync(ledgerFile(r.root, "T2"), "utf8"), before);
  assert.equal(tipOf(r.root, "agentry/T2"), t2);
  holder.kill();
  assert.equal(await gated, 0, "the queued gate runs on the tip it was asked about");
  // The gate is done: the restack goes ahead, and its record stays.
  const res = lane(r, "restack", "T2");
  assert.equal(res.exit, 0, res.out);
  const ledger = ledgerOf(r.root, "T2");
  assert.deepEqual(
    [ledger.restacks?.length, ledger.base, tipOf(r.root, "agentry/T2^")],
    [1, moved, moved],
  );
  assert.ok(!existsSync(join(r.root, ".agentry", "run", "process", "gating", "T2.json")));
});

// T2 stacked on a verified T1, built and verified PASS: its gate next. Returns T2's tip.
function toGate(r) {
  const out = lane(r, "start", "T2", "--on", "T1").json;
  build(out, "two.txt");
  judge(lane(r, "report", "T2").json, "PASS");
  assert.equal(lane(r, "verdict", "T2").json.next, "gate");
  return tipOf(r.root, "agentry/T2");
}

test("a gate whose lane moved while it ran writes nothing and exits 1, naming what moved", () => {
  // The gate runs $HOME/hook.sh when there is one: what another step does to the lane meanwhile.
  const spec = {
    ...SPEC,
    gate: {
      tiers: [
        { name: "full", command: ["sh", "-c", 'test ! -f "$HOME/hook.sh" || sh "$HOME/hook.sh"'] },
      ],
    },
  };
  const r = repo(undefined, spec);
  verified(r, "T1", "one.txt");
  const t2 = toGate(r);
  const file = ledgerFile(r.root, "T2");
  const fake = "0".repeat(40);
  writeFileSync(
    join(r.home, "hook.sh"),
    `node -e 'const fs=require("fs");const l=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));l.base="${fake}";fs.writeFileSync(process.argv[1],JSON.stringify(l))' '${file}'\n`,
  );
  const base = ledgerOf(r.root, "T2").base;
  const res = lane(r, "gate", "T2");
  assert.equal(res.exit, 1, res.out);
  assert.match(
    res.out,
    new RegExp(
      `✗ lane exec gate T2: T2 moved while its gate ran \\(base ${short(base)} → 0000000\\): the gate's record is not written → .*exec gate T2 --root `,
    ),
  );
  const after = ledgerOf(r.root, "T2");
  assert.deepEqual([after.base, after.gates.length, after.next], [fake, 0, "gate"]);
  // The branch moved under the gate: named the same way.
  writeLedgerBack(r.root, "T2", { base });
  writeFileSync(
    join(r.home, "hook.sh"),
    "git commit -q --allow-empty -m 'chore: under the gate'\n",
  );
  const tip = lane(r, "gate", "T2");
  assert.equal(tip.exit, 1, tip.out);
  assert.match(
    tip.out,
    new RegExp(
      `T2 moved while its gate ran \\(agentry/T2 ${short(t2)} → ${short(tipOf(r.root, "agentry/T2"))}\\)`,
    ),
  );
  assert.equal(ledgerOf(r.root, "T2").gates.length, 0);
});

function writeLedgerBack(root, id, changes) {
  const file = ledgerFile(root, id);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...changes }));
}

// The refusal came from the step after the rebase, so the branch had already moved.
test("restack refuses a lane held at its notes cap before any rebase: the branch tip is unmoved", () => {
  const r = repo();
  verified(r, "T1", "one.txt", { close: false });
  verified(r, "T2", "two.txt", { on: "T1", close: false });
  commitFile(ledgerOf(r.root, "T1").worktree, "one.txt", "moved\n", "fix: T1 moves");
  writeLedgerBack(r.root, "T2", {
    state: "held",
    next: "resume",
    hold: {
      for: "owner",
      when: "verdict",
      reason: "notes cap reached with open notes on a flagged item",
      since: new Date().toISOString(),
      round: 2,
    },
  });
  const before = state(r.root);
  const res = lane(r, "restack", "T2", "--main");
  assert.equal(res.exit, 2, res.out);
  assert.deepEqual(state(r.root), before, "branch tips, worktrees and ledgers unchanged");
  assert.match(res.out, /T2 is held at its notes cap: resume or fix --owner, then restack/);
});
