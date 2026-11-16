// Tests for the exec steps that stop costing rounds (R2c-1): `fact` writes the asked-for fact into the
// waiting brief, `start` warns of an empty owns and a ⚑ with no flag, `report` and `verdict` save a reply
// from `--from`, `fix --owner` voids a verifier that saved nothing, and `owns --add` on a parked
// verified lane says the way on. `lane exec` on temp git repos; builders and verifiers are simulated.
// Run: node --test plugin/scripts/test/exec-round-savers.test.mjs
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
  name: "Savers",
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
const BOARD_MD = `# Savers

## Tasks

| Task | Status | Verdict |
| ---- | ------ | ------- |
| F1   | todo   |         |
| F2   | todo   |         |
| F3   | todo   |         |
| E1   | todo   |         |
| G1   | todo   |         |
`;
const TASKS_MD = `# Tasks

### F1 · One

- **Owns:** \`one.txt\`. Accept: one.txt exists.

### F2 · Two

- **Owns:** \`two.txt\`. Accept: two.txt exists.

### F3 · Three

- **Owns:** \`three.txt\`. Accept: three.txt exists.

### E1 · No owns

- Accept: something exists.

### G1 · Marked ⚑

- **Owns:** \`g.txt\`. ⚑ Accept: g.txt exists.
`;

function repo() {
  const root = temp("savers-repo-");
  const home = temp("savers-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  commitFile(root, ".gitignore", ".agentry/run/\n.agentry/config.json\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  writeSpec(join(root, ".agentry"), SPEC);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  return { root, home };
}
function lane(r, args, input) {
  const res = spawnSync("node", [LANE, "exec", ...args, "--json", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
    input,
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* a refusal on stderr */
  }
  return { exit: res.status, json, stdout: res.stdout, stderr: res.stderr };
}
const ledgerOf = (root, id) =>
  JSON.parse(
    readFileSync(join(root, ".agentry", "run", "process", "ledger", `${id}.json`), "utf8"),
  );
function build(out, file) {
  commitFile(out.worktree, file, "made\n", `feat: add ${file}`);
  writeFileSync(out.reportPath, `DONE\nadded ${file}\nused_memories: none\n`);
}
const scratch = (r, name, text) => {
  const file = join(r.home, name);
  writeFileSync(file, text);
  return file;
};

// ---- fact (#123) -----------------------------------------------------------------------------

function askedLane(r, id = "F1") {
  const out = lane(r, ["start", id]).json;
  writeFileSync(out.reportPath, "NEEDS_CONTEXT\nwhich key?\nused_memories: none\n");
  return lane(r, ["report", id, "--agent", "builder-1"]).json;
}

test("report's todo line names exec fact; fact writes the section at the end of the brief and prints its path", () => {
  const r = repo();
  const asked = askedLane(r);
  assert.equal(asked.next, "needs-context");
  assert.match(asked.todo, /exec fact F1 --root '[^']*' --text "<fact>"/);
  const brief = () => readFileSync(asked.brief, "utf8");
  assert.doesNotMatch(brief(), /^## The fact$/m);
  const res = lane(r, ["fact", "F1", "--text", "the key is id"]);
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.brief, asked.brief);
  assert.ok(brief().endsWith("\n\n## The fact\n\nthe key is id\n"), brief());
});

test("a second fact replaces the section: the brief holds one", () => {
  const r = repo();
  const asked = askedLane(r);
  lane(r, ["fact", "F1", "--text", "alpha-fact"]);
  assert.equal(lane(r, ["fact", "F1", "--text", "beta-fact"]).exit, 0);
  const brief = readFileSync(asked.brief, "utf8");
  assert.equal(brief.match(/^## The fact$/gm).length, 1);
  assert.ok(brief.endsWith("\n\n## The fact\n\nbeta-fact\n"));
  assert.doesNotMatch(brief, /alpha-fact/);
});

test("fact is refused with no round asking for one, on a lane held for context, and with no text", () => {
  const r = repo();
  const out = lane(r, ["start", "F1"]).json;
  const building = lane(r, ["fact", "F1", "--text", "x"]);
  assert.equal(building.exit, 2);
  assert.match(building.stderr, /fact is for a needs-context round waiting for its builder/);
  assert.equal(lane(r, ["fact", "F1"]).exit, 2);
  assert.equal(lane(r, ["fact", "F1", "--text", "  "]).exit, 2);
  // Asked twice in the step: held for the context, whose answer is the resume.
  writeFileSync(out.reportPath, "NEEDS_CONTEXT\nq\nused_memories: none\n");
  const second = lane(r, ["report", "F1"]).json;
  writeFileSync(second.reportPath, "NEEDS_CONTEXT\nq again\nused_memories: none\n");
  assert.equal(lane(r, ["report", "F1"]).json.state, "held");
  const held = lane(r, ["fact", "F1", "--text", "x"]);
  assert.equal(held.exit, 2);
  assert.match(
    held.stderr,
    /held for more context: answer it with .*exec resume F1 .*--note "<the fact>"/,
  );
});

test("the supplied-context block does not claim a fact the brief lacks", () => {
  const r = repo();
  const asked = askedLane(r);
  const brief = readFileSync(asked.brief, "utf8");
  assert.match(brief, /## Supplied context\n\nYou asked for a fact in /);
  assert.doesNotMatch(brief, /The conductor added it/);
  assert.match(brief, /If it has no such section, no fact was supplied/);
});

// ---- start warnings (#129, #122) -------------------------------------------------------------

test("start warns when owns is empty, naming the owns --add step", () => {
  const r = repo();
  const out = lane(r, ["start", "E1"]).json;
  assert.match(
    out.warning,
    /^! owns is empty: the builder will stop to ask for each file; add them with `.*exec owns E1 .*--add <paths> --apply`$/m,
  );
});

test("start warns when the contract has ⚑ and the item's flag is empty, and not otherwise", () => {
  const r = repo();
  const marked = lane(r, ["start", "G1"]).json;
  assert.match(marked.warning, /^! the contract text has ⚑ but the board item's flag is empty/m);
  assert.doesNotMatch(marked.warning, /owns is empty/);
  const plain = lane(r, ["start", "F1"]).json;
  assert.equal(plain.warning, undefined);
});

// ---- --from (#133) ----------------------------------------------------------------------------

test("report --from saves the file at the round's report path, then reads it", () => {
  const r = repo();
  const out = lane(r, ["start", "F1"]).json;
  commitFile(out.worktree, "one.txt", "made\n", "feat: add one.txt");
  const reply = "DONE\nadded one.txt\nused_memories: none\n";
  const res = lane(r, ["report", "F1", "--from", scratch(r, "reply.md", reply)]);
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify");
  assert.equal(readFileSync(out.reportPath, "utf8"), reply);
});

test("verdict --from - reads the verifier's reply from stdin", () => {
  const r = repo();
  const out = lane(r, ["start", "F1"]).json;
  build(out, "one.txt");
  const verify = lane(r, ["report", "F1"]).json;
  const reply = "All checked.\nused_memories: none\nVerdict: PASS\n";
  const res = lane(r, ["verdict", "F1", "--from", "-"], reply);
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "gate");
  assert.equal(readFileSync(verify.reportPath, "utf8"), reply);
});

test("--from refuses a different report already at the path, and goes on with an identical one", () => {
  const r = repo();
  const out = lane(r, ["start", "F1"]).json;
  build(out, "one.txt");
  const was = readFileSync(out.reportPath, "utf8");
  const other = lane(r, [
    "report",
    "F1",
    "--from",
    scratch(r, "other.md", "DONE\nsomething else\n"),
  ]);
  assert.equal(other.exit, 2);
  assert.match(other.stderr, /a different report already sits at .*r1-build\.report\.md/);
  assert.equal(readFileSync(out.reportPath, "utf8"), was, "the saved report is untouched");
  assert.equal(ledgerOf(r.root, "F1").rounds.length, 1, "nothing was recorded");
  const same = lane(r, ["report", "F1", "--from", scratch(r, "same.md", was)]);
  assert.equal(same.exit, 0, same.stderr);
});

test("--from refuses a missing or empty file, nothing saved", () => {
  const r = repo();
  const out = lane(r, ["start", "F1"]).json;
  const missing = lane(r, ["report", "F1", "--from", join(r.home, "none.md")]);
  assert.equal(missing.exit, 2);
  assert.match(missing.stderr, /--from .* cannot be read/);
  const empty = lane(r, ["report", "F1", "--from", scratch(r, "empty.md", "\n")]);
  assert.equal(empty.exit, 2);
  assert.match(empty.stderr, /is empty/);
  assert.equal(lane(r, ["show", "F1"]).json.reportPath, out.reportPath);
  assert.throws(() => readFileSync(out.reportPath), /ENOENT/);
});

test("--from belongs to report and verdict only", () => {
  const r = repo();
  const res = lane(r, ["show", "F1", "--from", "x"]);
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /show takes no --from/);
});

// ---- fix --owner on a verifier that saved nothing (#139) ---------------------------------------

test("fix --owner voids a verify round with no saved report and briefs the owner's change", () => {
  const r = repo();
  const out = lane(r, ["start", "F2"]).json;
  build(out, "two.txt");
  const verify = lane(r, ["report", "F2", "--agent", "builder-1"]).json;
  assert.equal(verify.next, "verify");
  const res = lane(r, ["fix", "F2", "--owner", "rename two.txt"]);
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual([res.json.next, res.json.mode, res.json.agent], ["fix", "resume", "builder-1"]);
  assert.match(res.json.voided, /^round 2 \(verify\): no report was saved$/);
  const ledger = ledgerOf(r.root, "F2");
  assert.deepEqual(
    [ledger.rounds[1].void, ledger.rounds[1].voidedBy, ledger.rounds[1].report],
    [true, "owner", undefined],
  );
  assert.equal(ledger.ownerFixes.length, 1);
  assert.match(
    readFileSync(res.json.brief, "utf8"),
    /## The owner's change\n\n.*\n\n> rename two\.txt/,
  );
  // The fix reports as any: no verdict was counted, so a fresh verifier reads it.
  commitFile(res.json.worktree, "two-b.txt", "made\n", "feat: rename it");
  writeFileSync(res.json.reportPath, "DONE\nrenamed\nused_memories: none\n");
  assert.equal(lane(r, ["report", "F2"]).json.next, "verify");
});

test("fix --owner is refused as before when the verifier's report is saved", () => {
  const r = repo();
  const out = lane(r, ["start", "F3"]).json;
  build(out, "three.txt");
  const verify = lane(r, ["report", "F3"]).json;
  writeFileSync(verify.reportPath, "All checked.\nused_memories: none\nVerdict: PASS\n");
  const before = readFileSync(
    join(r.root, ".agentry", "run", "process", "ledger", "F3.json"),
    "utf8",
  );
  const res = lane(r, ["fix", "F3", "--owner", "change it"]);
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /fix --owner is for a verified lane: F3 is verifying \(next verify\)/);
  assert.equal(
    readFileSync(join(r.root, ".agentry", "run", "process", "ledger", "F3.json"), "utf8"),
    before,
  );
});

// ---- owns on a parked verified lane (#138) -----------------------------------------------------

test("owns --add on a parked verified lane says why and the way on: resume it, then fix", () => {
  const r = repo();
  const out = lane(r, ["start", "F1"]).json;
  build(out, "one.txt");
  const verify = lane(r, ["report", "F1"]).json;
  writeFileSync(verify.reportPath, "All checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, ["verdict", "F1"]).json.next, "gate");
  assert.equal(lane(r, ["gate", "F1"]).json.state, "verified");
  assert.equal(lane(r, ["hold", "F1", "--for", "later"]).exit, 0);
  const res = lane(r, ["owns", "F1", "--add", "extra.txt", "--apply"]);
  assert.equal(res.exit, 2);
  assert.match(
    res.stderr,
    /owns --add is for a lane still building: F1 is parked verified \(next close\), its work built and checked, so a change to it is the owner's: resume it \(.*exec resume F1 .*--note "<why>"\), then .*exec fix F1 .*--owner "<the change>"/,
  );
});
