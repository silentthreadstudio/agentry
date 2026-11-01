// Tests for `lane session start|close` (lib/lane/cli/session.mjs) on the drift fixture board: start shows
// the Now sprint, the nudges, the drafts and the mode in at most 40 lines; close gathers the drafts, the
// board-fix plan, the ledgers and what a sweep would clean, and writes nothing.
// Run: node --test plugin/scripts/test/session-cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as drafts from "../lib/process/drafts.mjs";
import { boardRepo, builtBranch, handBranch, ledger, read } from "./drift-repo.mjs";
import { git, gitEnv } from "./git-repo.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const home = mkdtempSync(join(tmpdir(), "session-home-"));
const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});

function fresh() {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  return repo.root;
}
const session = (root, ...args) =>
  spawnSync("node", [LANE, "session", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });

test("start prints the Now sprint, the nudges, the drafts and the mode in at most 40 lines", () => {
  const root = fresh();
  handBranch(root, "agent-tree", "worktree-agent-x");
  drafts.add(root, { kind: "decision", answer: "Use A", question: "A or B?" });
  mkdirSync(join(root, ".agentry"), { recursive: true });
  writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify({ mode: "night" }));
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split("\n");
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.ok(lines.every((l) => [...l].length <= 80));
  assert.match(res.stdout, /session start · mode night/);
  assert.match(res.stdout, /now: S1 .*— 0\/3 done/);
  assert.match(res.stdout, /in flight: T1 \(doing\), T3 \(verify\)/);
  assert.match(res.stdout, /drift: unlisted-worktree .*→ \/agentry:exec/);
  assert.match(res.stdout, /drafts: 1 pending → \/agentry:close/);
  assert.match(res.stdout, /conductor prompt: .*CONDUCTOR\.md/);
});

test("start --json carries prompt, mode, status, recall, questions and ledgers", () => {
  const root = fresh();
  ledger(root, "T1");
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.deepEqual(Object.keys(data).sort(), [
    "ledgers",
    "mode",
    "prompt",
    "questions",
    "recall",
    "status",
  ]);
  assert.equal(data.mode, null);
  assert.deepEqual(data.ledgers, [{ id: "T1", state: "building", next: "report" }]);
});

test("start ranks this repo's remembered facts against the work in flight", () => {
  const root = fresh();
  const dir = join(root, ".agentry", "memory", "facts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "f1.md"),
    "---\nid: f1\ntype: gotcha\nscope: repo\nstatus: active\nconfidence: 0.9\ntags:\n  - first\n---\nThe first task needs its cache cleared.\n",
  );
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.equal(data.recall[0].id, "f1");
});

test("close gathers drafts, the fix plan, ledgers and sweep findings, and writes nothing", () => {
  const root = fresh();
  drafts.add(root, { kind: "rule", answer: "Always X" });
  const built = builtBranch(root, "T1");
  git(root, "cherry-pick", built.sha);
  ledger(root, "T1", { state: "merged", worktree: built.path });
  ledger(root, "T3", { episode: { payload: {} } });
  const before = read(root, "plan/BOARD.md");
  const res = session(root, "close");
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  assert.equal(data.drafts.length, 1);
  assert.equal(data.fixPlan.dryRun, true);
  assert.equal(data.fixPlan.fixed[0].id, "T1");
  assert.deepEqual(
    data.cleanable.map((w) => w.id),
    ["T1"],
  );
  assert.deepEqual(data.episodesPending, ["T3"]);
  assert.deepEqual(data.strays, []);
  assert.equal(typeof data.diskFree, "number");
  assert.equal(read(root, "plan/BOARD.md"), before);
});

test("a missing or unknown step is a usage error", () => {
  const root = fresh();
  assert.equal(session(root).status, 2);
  assert.equal(session(root, "later").status, 2);
});
