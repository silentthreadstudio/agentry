// Tests for the owner's calls on a lane or a spike (field 90) on temp git repos: `lane note <id> --owner`
// appends one to the open ledger, else to the spike filed for the item; with no flag it lists them;
// `--recorded` marks them written down; `exec adopt` moves a spike's calls into the new ledger; `exec close`'s
// episode counts them. A refused note writes nothing, and a ledger or `spikes.json` that cannot be read is
// named and never written over. (`session close`'s list: session-cli.test.mjs.)
// Run: node --test plugin/scripts/test/owner-calls.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ledger } from "./drift-repo.mjs";
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
  name: "Calls",
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
const BOARD_MD = `# Calls

## Tasks

| Task | Status | Verdict |
| ---- | ------ | ------- |
| T1   | todo   |         |
| T2   | todo   |         |
`;
const TASKS_MD = `# Tasks

### T1 · One

- **Owns:** \`one.txt\`. Accept: one.txt exists.

### T2 · Two

- **Owns:** \`two.txt\`. Accept: two.txt exists.
`;

function repo() {
  const root = temp("calls-repo-");
  const home = temp("calls-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  writeSpec(join(root, ".agentry"), SPEC);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  return { root, home };
}
function lane({ root, home }, ...args) {
  const res = spawnSync("node", [LANE, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* text, or a refusal on stderr */
  }
  return { exit: res.status, json, stdout: res.stdout, stderr: res.stderr };
}
const note = (r, ...args) => lane(r, "note", ...args);
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const spikesFile = (root) => join(root, ".agentry", "run", "spikes.json");
const spikesOf = (root) => JSON.parse(readFileSync(spikesFile(root), "utf8"));
const bytes = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

// An agent's worktree with one commit, filed as a spike for `id`.
function spike(r, id, name = "a1") {
  const path = join(r.root, ".claude", "worktrees", `agent-${name}`);
  const branch = `worktree-agent-${name}`;
  git(r.root, "worktree", "add", "-q", "-b", branch, path, "main");
  commitFile(path, "one.txt", `by ${name}\n`, `feat: one by ${name}`);
  const filed = lane(r, "spike", branch, "--for", id);
  assert.equal(filed.exit, 0, filed.stderr);
  return { path, branch };
}

test("--owner appends { n, at, text, recorded: null } to the open ledger's calls", () => {
  const r = repo();
  ledger(r.root, "T1");
  const first = note(r, "T1", "--owner", "keep the old flag for one release", "--json");
  assert.equal(first.exit, 0, first.stderr);
  assert.equal(note(r, "t1", "--owner", "ship without the migration").exit, 0, "any case");
  const { calls } = ledgerOf(r.root, "T1");
  assert.deepEqual(
    calls.map(({ n, text, recorded }) => ({ n, text, recorded })),
    [
      { n: 1, text: "keep the old flag for one release", recorded: null },
      { n: 2, text: "ship without the migration", recorded: null },
    ],
  );
  assert.match(calls[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(first.json.noted, calls[0]);
  assert.deepEqual(first.json.holders[0].on, "lane");
  assert.equal(existsSync(spikesFile(r.root)), false, "no spike file is written");
  assert.deepEqual(
    readdirSync(dirname(ledgerFile(r.root, "T1"))).filter((f) => f.endsWith(".tmp")),
    [],
    "the write leaves no temp file",
  );
});

test("with no open ledger, --owner appends to the spike filed for the id", () => {
  const r = repo();
  ledger(r.root, "T1", { state: "merged", next: null });
  const s = spike(r, "T1");
  const res = note(r, "T1", "--owner", "the spike's numbers stand");
  assert.equal(res.exit, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`^noted call 1 on spike ${s.branch} of T1`));
  const [entry] = spikesOf(r.root);
  assert.equal(entry.branch, s.branch);
  assert.deepEqual(
    entry.calls.map((c) => [c.n, c.text, c.recorded]),
    [[1, "the spike's numbers stand", null]],
  );
  assert.equal(ledgerOf(r.root, "T1").calls, undefined, "the merged ledger is not written");
});

test("an id with no lane and no spike refuses and writes nothing", () => {
  const r = repo();
  const res = note(r, "T2", "--owner", "a call");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /T2 has no lane or spike → lane spike <branch> --for T2, or exec adopt/);
  assert.equal(existsSync(spikesFile(r.root)), false);
  assert.equal(existsSync(ledgerFile(r.root, "T2")), false);
  assert.equal(note(r, "T2").exit, 2, "nothing to list either");
});

test("an empty or multi-line call refuses and writes nothing", () => {
  const r = repo();
  ledger(r.root, "T1");
  const before = bytes(ledgerFile(r.root, "T1"));
  for (const text of ["", "   ", "first line\nsecond line", "a\rb"]) {
    const res = note(r, "T1", "--owner", text);
    assert.equal(res.exit, 2, JSON.stringify(text));
    assert.equal(bytes(ledgerFile(r.root, "T1")), before, JSON.stringify(text));
  }
});

test("with no flag it lists the calls as n · at · recorded|not written down · text", () => {
  const r = repo();
  ledger(r.root, "T1");
  note(r, "T1", "--owner", "first call");
  note(r, "T1", "--owner", "second call");
  note(r, "T1", "--recorded", "1");
  const res = note(r, "T1");
  assert.equal(res.exit, 0, res.stderr);
  const rows = res.stdout.split("\n").filter((l) => l.startsWith("  "));
  assert.match(rows[0], /^ {2}1 · \d{4}-\d\d-\d\dT[^ ]+ · recorded · first call$/);
  assert.match(rows[1], /^ {2}2 · \d{4}-\d\d-\d\dT[^ ]+ · not written down · second call$/);
  assert.equal(rows.length, 2);
});

test("--recorded marks calls written down with { at, where }; all marks the rest", () => {
  const r = repo();
  ledger(r.root, "T1");
  for (const t of ["one", "two", "three"]) note(r, "T1", "--owner", t);
  const res = note(r, "T1", "--recorded", "1,3", "--where", "plan/DECISIONS.md D4", "--json");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual(res.json.marked, [1, 3]);
  const calls = ledgerOf(r.root, "T1").calls;
  assert.equal(calls[0].recorded.where, "plan/DECISIONS.md D4");
  assert.match(calls[0].recorded.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(calls[1].recorded, null);
  assert.equal(calls[2].recorded.where, "plan/DECISIONS.md D4");
  assert.equal(note(r, "T1", "--recorded", "all").exit, 0);
  const after = ledgerOf(r.root, "T1").calls;
  assert.deepEqual(after[1].recorded.where, null);
  assert.deepEqual(after[0].recorded, calls[0].recorded, "a marked call keeps its record");
});

test("--recorded with a number no call has refuses and writes nothing", () => {
  const r = repo();
  ledger(r.root, "T1");
  note(r, "T1", "--owner", "one");
  const before = bytes(ledgerFile(r.root, "T1"));
  const res = note(r, "T1", "--recorded", "1,4");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /no call 4/);
  assert.equal(bytes(ledgerFile(r.root, "T1")), before);
  for (const bad of ["0", "x", "1,,2"]) assert.equal(note(r, "T1", "--recorded", bad).exit, 2);
  assert.equal(note(r, "T1", "--where", "a file").exit, 2, "--where goes with --recorded");
  assert.equal(bytes(ledgerFile(r.root, "T1")), before);
});

test("adopt moves the spike's calls into the new ledger, numbering kept; the spike keeps none", () => {
  const r = repo();
  const s = spike(r, "T1");
  note(r, "T1", "--owner", "one on the spike");
  note(r, "T1", "--owner", "two on the spike");
  note(r, "T1", "--recorded", "1");
  const onSpike = spikesOf(r.root)[0].calls;
  const res = lane(r, "exec", "adopt", "T1", "--branch", s.branch, "--json");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual(ledgerOf(r.root, "T1").calls, onSpike);
  const [entry] = spikesOf(r.root);
  assert.equal(entry.branch, s.branch, "the spike entry stays filed");
  assert.equal(entry.calls, undefined, "with no calls");
  assert.equal(note(r, "T1", "--owner", "three on the lane").exit, 0);
  assert.deepEqual(
    ledgerOf(r.root, "T1").calls.map((c) => c.n),
    [1, 2, 3],
  );
});

test("filing a spike again keeps its calls", () => {
  const r = repo();
  const s = spike(r, "T1");
  note(r, "T1", "--owner", "kept across a refile");
  assert.equal(lane(r, "spike", s.branch, "--for", "T1").exit, 0);
  assert.deepEqual(
    spikesOf(r.root)[0].calls.map((c) => c.text),
    ["kept across a refile"],
  );
});

test("two spikes filed for one id: --owner refuses, naming both", () => {
  const r = repo();
  spike(r, "T1", "a1");
  spike(r, "T1", "a2");
  const before = bytes(spikesFile(r.root));
  const res = note(r, "T1", "--owner", "which one?");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /T1 has spikes on worktree-agent-a1, worktree-agent-a2/);
  assert.equal(bytes(spikesFile(r.root)), before);
});

test("a torn ledger or spikes.json is named and never written over", () => {
  const r = repo();
  ledger(r.root, "T1");
  writeFileSync(ledgerFile(r.root, "T1"), '{ "v": 1, "id": "T1", "sta');
  const torn = note(r, "T1", "--owner", "a call");
  assert.equal(torn.exit, 2);
  assert.ok(torn.stderr.includes(ledgerFile(r.root, "T1")), torn.stderr);
  assert.equal(bytes(ledgerFile(r.root, "T1")), '{ "v": 1, "id": "T1", "sta');
  const r2 = repo();
  spike(r2, "T1");
  writeFileSync(spikesFile(r2.root), "[{");
  for (const args of [["--owner", "a call"], ["--recorded", "all"], []]) {
    const res = note(r2, "T1", ...args);
    assert.equal(res.exit, 2, args.join(" "));
    assert.ok(res.stderr.includes(spikesFile(r2.root)), res.stderr);
  }
  assert.equal(bytes(spikesFile(r2.root)), "[{");
});

test("--json carries every call's text whole", () => {
  const r = repo();
  ledger(r.root, "T1");
  const long = `keep ${"the long reason ".repeat(40)}end`;
  note(r, "T1", "--owner", long);
  const res = note(r, "T1", "--json");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.holders[0].calls[0].text, long);
});

test("exec close's episode names the lane's calls and how many are written down", () => {
  const r = repo();
  ledger(r.root, "T1");
  for (const t of ["one", "two", "three"]) note(r, "T1", "--owner", t);
  note(r, "T1", "--recorded", "2");
  const merged = { ...ledgerOf(r.root, "T1"), state: "merged", next: null };
  writeFileSync(ledgerFile(r.root, "T1"), JSON.stringify(merged));
  const res = lane(r, "exec", "close", "T1", "--json");
  assert.equal(res.exit, 0, res.stderr);
  assert.match(res.json.episode.outcome, /owner calls: 3 \(1 written down\)/);
});
