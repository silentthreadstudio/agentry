// Tests for landing stacked lanes (A45) on temp git repos: a stacked lane lands only after its parent and
// only once restacked onto main; the parent's land names its children and restacks each one at rest onto
// main itself, leaving one with an agent out or a conflict as it was. Lanes are real `lane exec` walks;
// builders and verifiers are simulated by committing in the worktree and writing their report files.
// Run: node --test plugin/scripts/test/merge-stack.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
| T4   | todo   |         |        |
`;
const TASKS_MD = `# Tasks

- **T1**: owns \`one.txt\`. Accept: one.txt exists.
- **T2**: owns \`two.txt\`. Accept: two.txt exists.
- **T3**: owns \`three.txt\`, \`shared.txt\`. Accept: three.txt exists.
- **T4**: owns \`four.txt\`, \`shared.txt\`. Accept: four.txt exists.
`;

function repo() {
  const root = temp("merge-stack-repo-");
  const home = temp("merge-stack-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  // merge.push "never": the land's next is the cleanup, no push is asked.
  writeFileSync(
    join(root, ".agentry", "config.json"),
    JSON.stringify({ merge: { push: "never" } }),
  );
  commitFile(root, ".gitignore", ".agentry/run/\n.agentry/config.json\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "shared.txt", "a\nb\nc\n");
  writeSpec(join(root, ".agentry"), SPEC);
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
const merge = (r, ...args) => {
  const res = run(r, "merge", args);
  return { exit: res.status, out: res.stdout + res.stderr };
};
const land = (r, id) => merge(r, id, "--message", `chore(board): land ${id}`);
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const ledgerText = (root, id) => readFileSync(ledgerFile(root, id), "utf8");
const tipOf = (root, ref) => git(root, "rev-parse", ref);
const short = (sha) => sha.slice(0, 7);

function build(out, file, body = "made\n") {
  commitFile(out.worktree, file, body, `feat: ${file}`);
  writeFileSync(out.reportPath, `DONE\nadded ${file}\nused_memories: none\n`);
}
const judge = (out, verdict = "PASS") =>
  writeFileSync(
    out.reportPath,
    `All acceptance items checked.\nused_memories: none\nVerdict: ${verdict}\n`,
  );
// Lane `id` built (its builder adding `file`) up to its verifier out.
function toVerdict(r, id, file, { body, on } = {}) {
  let out = lane(r, "start", id, ...(on ? ["--on", on] : [])).json;
  build(out, file, body);
  out = lane(r, "report", id).json;
  assert.equal(out.next, "verify");
  return out;
}
// The rest of a lane whose verifier is out: PASS, the gate, close.
function finish(r, id, out) {
  judge(out);
  assert.equal(lane(r, "verdict", id).json.next, "gate");
  const gate = lane(r, "gate", id);
  assert.equal(gate.exit, 0, gate.out);
  assert.equal(lane(r, "close", id).exit, 0);
}
const verified = (r, id, file, opts) => finish(r, id, toVerdict(r, id, file, opts));

test("a stacked lane lands only after its parent: preflight exit 1, land exit 2, main and its ledger unchanged", () => {
  const r = repo();
  verified(r, "T1", "one.txt");
  verified(r, "T2", "two.txt", { on: "T1" });
  const head = tipOf(r.root, "main");
  const ledger = ledgerText(r.root, "T2");
  const pf = merge(r, "T2", "--preflight");
  assert.equal(pf.exit, 1, pf.out);
  assert.match(
    pf.out,
    /✗ stack {3}T2 is stacked on T1, which is not merged \(T1 is verified\): land T1 first\nnext: lane merge T1 --preflight/,
  );
  const landed = land(r, "T2");
  assert.equal(landed.exit, 2, landed.out);
  assert.match(landed.out, /✗ stack {3}T2 is stacked on T1, which is not merged/);
  assert.equal(tipOf(r.root, "main"), head);
  assert.equal(ledgerText(r.root, "T2"), ledger);
  // The parent's preflight names what is stacked on it.
  assert.match(merge(r, "T1", "--preflight").out, /· stack {3}stacked on T1: T2/);
});

test("T1's land names T2 with its verifier out; T2 then needs a restack, after which it lands only its own commits", () => {
  const r = repo();
  verified(r, "T1", "one.txt");
  const out = toVerdict(r, "T2", "two.txt", { on: "T1" });
  const t1 = land(r, "T1");
  assert.equal(t1.exit, 0, t1.out);
  assert.match(t1.out, /! stack {3}T2 is stacked on T1: lane exec restack T2 before its gate/);
  assert.match(
    t1.out,
    /a verify round is out \(round 2, next verify\)/,
    "the row says why it was left",
  );
  finishVerdictOnly(r, "T2", out);
  const head = tipOf(r.root, "main");
  assert.match(
    lane(r, "gate", "T2").out,
    /T1 landed since T2 was cut on it: a gate here would not count/,
  );
  assert.equal(land(r, "T2").exit, 2, "not verified yet");
  assert.equal(tipOf(r.root, "main"), head);
  // The restack onto main, the gate on the new tip, then the land.
  const restacked = lane(r, "restack", "T2");
  assert.equal(restacked.exit, 0, restacked.out);
  assert.deepEqual(git(r.root, "cherry", "main", "agentry/T2").split("\n"), [
    `+ ${tipOf(r.root, "agentry/T2")}`,
  ]);
  assert.equal(lane(r, "gate", "T2").exit, 0);
  assert.equal(lane(r, "close", "T2").exit, 0);
  const pf2 = merge(r, "T2", "--preflight");
  assert.match(pf2.out, /✓ stack {3}restacked onto main after T1 landed \(\w{7} → \w{7}\)/);
  const t2 = land(r, "T2");
  assert.equal(t2.exit, 0, t2.out);
  assert.match(t2.out, /✓ gate {4}skipped: gate on \w{7}, tree identical/);
  assert.deepEqual(ledgerOf(r.root, "T2").merge.landed.length, 1, "exactly T2's one commit");
  const subjects = git(r.root, "log", "--format=%s", `${head}..main`).split("\n");
  assert.deepEqual(subjects, ["chore(board): land T2", "feat: two.txt"]);
});

// A verdict and the gate for a lane whose verifier is out, no close.
function finishVerdictOnly(r, id, out) {
  judge(out);
  const res = lane(r, "verdict", id);
  assert.equal(res.json.next, "gate");
  assert.match(res.json.stack, /T1 landed/);
}

test("when another lane landed between the restack and the land, the gate runs on main", () => {
  const r = repo();
  verified(r, "T1", "one.txt");
  verified(r, "T2", "two.txt", { on: "T1" });
  verified(r, "T4", "four.txt");
  assert.match(land(r, "T1").out, /✓ stack {3}restacked: T2 onto main \(1 commits\)/);
  assert.equal(lane(r, "gate", "T2").exit, 0);
  assert.equal(lane(r, "close", "T2").exit, 0);
  assert.equal(land(r, "T4").exit, 0);
  const t2 = land(r, "T2");
  assert.equal(t2.exit, 0, t2.out);
  assert.match(t2.out, /✓ gate {4}full ran on main: exit 0/);
});

test("T1's land restacks T2 (clean) onto main and leaves T3 (a conflict) as it was, naming only T3", () => {
  const r = repo();
  verified(r, "T1", "one.txt");
  verified(r, "T2", "two.txt", { on: "T1" });
  verified(r, "T3", "shared.txt", { on: "T1", body: "a\nT3\nc\n" });
  // Main moves under T3's file before T1 lands.
  verified(r, "T4", "shared.txt", { body: "a\nT4\nc\n" });
  assert.equal(land(r, "T4").exit, 0);
  const t3 = { tip: tipOf(r.root, "agentry/T3"), ledger: ledgerText(r.root, "T3") };
  const t3tree = ledgerOf(r.root, "T3").worktree;
  const res = land(r, "T1");
  assert.equal(res.exit, 0, res.out);
  const rows = res.out.split("\n").filter((l) => / stack {3}/.test(l));
  assert.deepEqual(rows, [
    "  ✓ stack   restacked: T2 onto main (1 commits)",
    "  ! stack   restack T3: conflict in shared.txt → lane exec restack T3 --main",
  ]);
  assert.equal(ledgerOf(r.root, "T2").on, undefined);
  assert.equal(git(r.root, "rev-parse", "agentry/T2^"), tipOf(r.root, "main"));
  assert.equal(tipOf(r.root, "agentry/T3"), t3.tip);
  assert.equal(ledgerText(r.root, "T3"), t3.ledger);
  assert.equal(git(t3tree, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(t3tree, "shared.txt"), "utf8"), "a\nT3\nc\n");
  // T3 is still verified, cut from T1's old tip: its land refuses until the restack, main untouched.
  const head = tipOf(r.root, "main");
  const board = ledgerOf(r.root, "T1").merge.boardCommit;
  const pf = merge(r, "T3", "--preflight");
  assert.equal(pf.exit, 1, pf.out);
  assert.match(
    pf.out,
    new RegExp(
      `✗ stack {3}T1 landed \\(1 commit\\(s\\), board ${short(board)}\\); T3 is still cut from T1's old tip ${short(ledgerOf(r.root, "T3").base)}\\nnext: lane exec restack T3`,
    ),
  );
  assert.equal(land(r, "T3").exit, 2);
  assert.deepEqual([tipOf(r.root, "main"), ledgerText(r.root, "T3")], [head, t3.ledger]);
});

test("a chain T3 --on T2 --on T1: merge T3 names T2", () => {
  const r = repo();
  verified(r, "T1", "one.txt");
  verified(r, "T2", "two.txt", { on: "T1" });
  verified(r, "T3", "three.txt", { on: "T2" });
  const pf = merge(r, "T3", "--preflight");
  assert.equal(pf.exit, 1);
  assert.match(
    pf.out,
    /✗ stack {3}T3 is stacked on T2, which is not merged \(T2 is verified\): land T2 first\nnext: lane merge T2 --preflight/,
  );
  // T1's land restacks T2 onto main; T3, on T2, is then due its parent, never main.
  assert.equal(land(r, "T1").exit, 0);
  assert.match(lane(r, "show", "T3").json.stack, /^on T2 at \w{7}; T2 moved to \w{7} → /);
});
