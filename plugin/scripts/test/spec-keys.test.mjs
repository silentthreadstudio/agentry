// Tests for the harness keys and the lifecycle invariants in lib/process/spec.mjs:
// the shared table through the plugin's validator, `gateOf`, the exec presets (`resolveWorkflow`), the CLI
// refusing a bad key (exit 2, naming it), the lifecycle writer's targets and the handoff self-consistency
// check.
// Run: node --test plugin/scripts/test/spec-keys.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../lib/process/spec.mjs";
import { PRESETS, resolveWorkflow } from "../lib/process/spec/presets.mjs";
import { gateOf } from "../lib/process/spec/workflow.mjs";
import { BASE, PROCESS_CASES, pathOf, specOf } from "./key-cases.mjs";
import { splitSpec, writeSpec } from "./spec-files.mjs";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const messages = (value) => validateSpec(splitSpec(value)).problems.map((p) => p.message);

test("the shared table: every good case loads, every bad case names exactly its paths", () => {
  for (const c of PROCESS_CASES) {
    const paths = [
      ...new Set(validateSpec(specOf(c)).problems.map((p) => pathOf(p.message))),
    ].sort();
    assert.deepEqual(paths, [...(c.bad ?? [])].sort(), c.name);
  }
});

const FULL_TIER = [{ name: "full", command: ["make", "test"] }];

test("gateOf fills the defaults, copies, and is null without a gate", () => {
  assert.equal(gateOf(BASE), null);
  const spec = { ...structuredClone(BASE), gate: { tiers: FULL_TIER } };
  const gate = gateOf(spec);
  assert.deepEqual(gate, {
    tiers: FULL_TIER,
    roles: { build: "pick", verify: "none", merge: "pick" },
    checklist: [],
    after: [],
    concurrency: 1,
    flaky: [],
    flakyLogs: [],
    note: null,
  });
  gate.tiers[0].command.push("--changed");
  gate.roles.build = "full";
  assert.deepEqual(spec.gate, { tiers: [{ name: "full", command: ["make", "test"] }] });
  const checklist = [{ name: "ui-smoke", text: "look" }];
  const set = { tiers: FULL_TIER, roles: { merge: "full" }, checklist, after: ["a.md"] };
  assert.deepEqual(gateOf({ ...spec, gate: set }), {
    tiers: FULL_TIER,
    roles: { build: "pick", verify: "none", merge: "full" },
    checklist,
    after: ["a.md"],
    concurrency: 1,
    flaky: [],
    flakyLogs: [],
    note: null,
  });
});

// ---- exec presets ------------------------------------------------------------------------------------

const GATED = { gate: { tiers: FULL_TIER } };
const TABLE = {
  lean: ["flagged", 0, "never", "gate", { build: "pick", verify: "none", merge: "pick" }],
  standard: ["all", 1, "after-fix", "recheck", { build: "pick", verify: "none", merge: "pick" }],
  strict: ["all", 3, "always", "recheck", { build: "full", verify: "none", merge: "full" }],
};
const five = ({ exec, roles }) => [exec.verify, exec.noteRounds, exec.final, exec.rebase, roles];

test("resolveWorkflow: each preset's five values, and standard when no preset is named", () => {
  assert.deepEqual(Object.keys(PRESETS), Object.keys(TABLE));
  for (const [preset, values] of Object.entries(TABLE)) {
    const got = resolveWorkflow({ ...GATED, exec: { preset } });
    assert.equal(got.preset, preset);
    assert.deepEqual(five(got), values, preset);
    assert.deepEqual(got.set, ["exec.preset"], preset);
  }
  const bare = resolveWorkflow(GATED);
  assert.deepEqual([bare.preset, ...five(bare)], ["standard", ...TABLE.standard]);
  assert.deepEqual(bare.set, []);
});

test("resolveWorkflow: a key in the file wins over its preset, alone; gate.roles per role", () => {
  const over = {
    "exec.verify": ["verify", "none"],
    "exec.noteRounds": ["noteRounds", 2],
    "exec.final": ["final", "never"],
    "exec.rebase": ["rebase", "gate"],
  };
  for (const preset of Object.keys(TABLE))
    for (const [path, [key, value]] of Object.entries(over)) {
      const got = resolveWorkflow({ ...GATED, exec: { preset, [key]: value } });
      const want = resolveWorkflow({ ...GATED, exec: { preset } });
      assert.equal(got.exec[key], value, `${preset} ${path}`);
      for (const other of Object.keys(want.exec).filter((k) => k !== key))
        assert.equal(got.exec[other], want.exec[other], `${preset} ${path} leaves ${other}`);
      assert.deepEqual(got.set, ["exec.preset", path]);
    }
  const roles = resolveWorkflow({
    gate: { tiers: FULL_TIER, roles: { merge: "pick" } },
    exec: { preset: "strict" },
  });
  assert.deepEqual(roles.roles, { build: "full", verify: "none", merge: "pick" });
  assert.deepEqual(roles.set, ["exec.preset", "gate.roles.merge"]);
  // set lists only the file's keys: one override, no preset named.
  assert.deepEqual(resolveWorkflow({ exec: { final: "never" } }).set, ["exec.final"]);
});

test("resolveWorkflow: roles are null without a gate; gateOf reads the preset's roles", () => {
  assert.equal(resolveWorkflow({ exec: { preset: "strict" } }).roles, null);
  const strict = { ...structuredClone(BASE), ...GATED, exec: { preset: "strict" } };
  assert.deepEqual(gateOf(strict).roles, { build: "full", verify: "none", merge: "full" });
});

test("the lean preset on a kind with no flag field is refused naming where flagged came from", () => {
  const problems = (exec) =>
    validateSpec({ board: structuredClone(BASE), workflow: { exec } }).problems.map(
      (p) => p.message,
    );
  assert.deepEqual(problems({ preset: "lean" }), [
    'exec.verify is "flagged" (preset lean), but the task kind has no field named "flag" of type "flag"',
  ]);
  assert.deepEqual(problems({ verify: "flagged" }), [
    'exec.verify is "flagged" (set), but the task kind has no field named "flag" of type "flag"',
  ]);
  assert.deepEqual(problems({ preset: "lean", verify: "all" }), []);
  assert.deepEqual(problems({ flagField: "urgent" }), [
    'exec.flagField is "urgent", but the task kind has no flag field named "urgent"',
  ]);
});

test("board check refuses a bad harness key with exit 2, naming its path", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-keys-"));
  temps.push(root);
  const file = join(root, "process.json");
  const runWith = (keys) => {
    writeSpec(root, { ...BASE, root: ".", ...keys });
    writeFileSync(
      join(root, "BOARD.md"),
      "## Tasks\n\n| Task | Status |\n| --- | --- |\n| T1 | todo |\n",
    );
    return spawnSync("node", [BOARD, "check", "--root", root, "--process", file], {
      encoding: "utf8",
    });
  };
  assert.equal(runWith({ gate: { tiers: FULL_TIER } }).status, 0);
  const bad = runWith({ gate: { tiers: [{ name: "Docs", command: ["x"] }] } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /gate\.tiers\[0\]\.name should be a name/);
  // The keys 0.3 replaced: refused with the pointer to gate.tiers.
  const old = runWith({
    gate: { command: ["x"], quick: { command: ["x", "-q"], only: ["d/**"] } },
  });
  assert.equal(old.status, 2);
  assert.match(
    old.stderr,
    /gate\.command replaced by gate\.tiers \(0\.3\): make it the last tier, \{ "name": "full", "command": \[…\] \}/,
  );
  assert.match(
    old.stderr,
    /gate\.quick replaced by gate\.tiers: a tier with "when": \{ "only": \[…\] \} before the last/,
  );
  const typo = runWith({ extensions: { merge: { checks: ["a", "a"] } } });
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /extensions\.merge\.checks\[1\] repeats "a"/);
  const none = runWith({ extensions: { merge: { checks: [] } } });
  assert.equal(none.status, 0, `merge.checks [] names no repo check: ${none.stderr}`);
  // The exec keys: each bad value exits 2 at load, naming its key.
  for (const [key, value] of [
    ["preset", "fast"],
    ["noteRounds", -1],
    ["noteRounds", 4],
    ["noteRounds", 1.5],
    ["noteRounds", "1"],
    ["final", "sometimes"],
    ["idleMinutes", 4],
  ]) {
    const res = runWith({ exec: { [key]: value } });
    assert.equal(res.status, 2, `${key} ${JSON.stringify(value)}`);
    assert.match(res.stderr, new RegExp(`exec\\.${key} should be`), key);
  }
});

// A board with a lifecycle on tasks: sprints own a file with a bold-lead handoff section.
const LIFE = {
  version: 1,
  name: "Life",
  root: ".",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      file: {
        glob: "sprints/{id}.md",
        sections: {
          handoff: { heading: "Handoff", as: "bold-lead" },
          members: { heading: "Tasks", as: "table", column: "Task" },
        },
      },
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
        deps: { column: "Deps", type: "list", ref: "task" },
      },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
    },
  },
  rules: [{ rule: "done-has-handoff", kind: "task", section: "handoff", commit: "first" }],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: {
      status: "status",
      verdict: "verdict",
      commit: "commit",
      handoff: "parent.file:handoff",
    },
    handoff: "- **{id}** ({sha}): {summary}",
  },
};
/** LIFE with `lifecycle` (or a rule) changed. */
const life = (change, rules) => ({
  ...structuredClone(LIFE),
  lifecycle: { ...structuredClone(LIFE.lifecycle), ...(change ?? {}) },
  ...(rules ? { rules } : {}),
});
const flags = (value, re) => messages(value).some((m) => re.test(m));

test("a well-formed lifecycle loads", () => {
  assert.deepEqual(messages(LIFE), []);
});

test("each lifecycle target is checked against the kind it writes", () => {
  const cases = [
    [{ on: { built: "verfy" } }, /^lifecycle\.on\.built "verfy" is not a task status/],
    [
      { write: { status: "verdict" } },
      /^lifecycle\.write\.status is "verdict", but task's status is read from "status"/,
    ],
    [{ write: { verdict: "verdikt" } }, /^lifecycle\.write\.verdict names no task field "verdikt"/],
    [
      { write: { verdict: "deps" } },
      /^lifecycle\.write\.verdict names the list field "deps" of task; it needs a text field/,
    ],
    [
      { write: { commit: "verdict" } },
      /^lifecycle\.write\.commit names the text field "verdict"; it needs a commits or evidence field/,
    ],
    [
      { write: { handoff: "parent.file:members" } },
      /^lifecycle\.write\.handoff names no bold-lead section "members" of the sprint file/,
    ],
    [
      { write: { handoff: "parent.file:handof" } },
      /^lifecycle\.write\.handoff names no bold-lead section "handof"/,
    ],
  ];
  for (const [change, re] of cases)
    assert.ok(flags(life(change), re), `${re}: ${messages(life(change))}`);
});

test("a handoff write needs a template; a template fills only {id}, {sha} and {summary}, on one line", () => {
  const noTemplate = structuredClone(LIFE);
  Reflect.deleteProperty(noTemplate.lifecycle, "handoff");
  assert.ok(flags(noTemplate, /^lifecycle\.write\.handoff needs the line it writes/));
  assert.ok(
    flags(
      life({ handoff: "- **{id}** ({sha}): {sumary}" }),
      /^lifecycle\.handoff fills no \{sumary\}/,
    ),
  );
  assert.ok(
    flags(
      life({ handoff: "- **{id}** ({sha}):\n{summary}" }),
      /^lifecycle\.handoff should be one line/,
    ),
  );
});

test("a handoff template the done-has-handoff rule would reject is a spec error at load", () => {
  // No bold lead: the rule finds no line for the task.
  assert.ok(
    flags(
      life({ handoff: "- {id} ({sha}): {summary}" }),
      /^lifecycle\.handoff renders "- X1 \(0a1b2c3\): a summary", which rules\[0\] \(done-has-handoff\) rejects: no handoff line/,
    ),
  );
  // commit "first": the SHA must come right after "(".
  assert.ok(
    flags(
      life({ handoff: "- **{id}** (commit {sha}): {summary}" }),
      /rejects: handoff line in its handoff section names no matching commit/,
    ),
  );
  assert.ok(
    flags(
      life({ handoff: "- **{id}**: {summary}" }),
      /rejects: handoff line .* names no matching commit/,
    ),
  );
  // The same templates pass a rule that names no commit.
  const none = [{ rule: "done-has-handoff", kind: "task", section: "handoff", commit: "none" }];
  assert.deepEqual(messages(life({ handoff: "- **{id}**: {summary}" }, none)), []);
  // Without the rule the template is not judged by it.
  assert.deepEqual(messages(life({ handoff: "- {id}: {summary}" }, [])), []);
});

test("a done-has-handoff rule on the lifecycle's kind needs a lifecycle.write.handoff target", () => {
  const missing = life();
  Reflect.deleteProperty(missing.lifecycle.write, "handoff");
  assert.ok(
    flags(
      missing,
      /^lifecycle\.write\.handoff is missing, but rules\[0\] \(done-has-handoff\) reads the task handoff/,
    ),
  );
  // No such rule (or none at all): the target is optional.
  const other = [{ rule: "ids-unique" }];
  for (const rules of [[], other]) {
    const spec = life(undefined, rules);
    Reflect.deleteProperty(spec.lifecycle.write, "handoff");
    assert.deepEqual(messages(spec), []);
  }
});

test("a handoff written to another section than the rule reads is refused", () => {
  const spec = life();
  spec.kinds.sprint.file.sections.notes = { heading: "Notes", as: "bold-lead" };
  spec.lifecycle.write.handoff = "parent.file:notes";
  assert.ok(
    flags(
      spec,
      /^lifecycle\.write\.handoff writes to section "notes", but rules\[0\] \(done-has-handoff\) reads "handoff"/,
    ),
  );
});

test("only merged may finish a task, and it writes what the done rules read", () => {
  console.log(
    JSON.stringify(
      messages(
        life({ write: (({ commit, ...r }) => r)(LIFE.lifecycle.write) }, [
          LIFE.rules[0],
          { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" },
        ]),
      ),
    ),
  );
  console.log(
    JSON.stringify(
      messages(
        life(undefined, [LIFE.rules[0], { rule: "done-signoff", kind: "task", field: "verdict" }]),
      ),
    ),
  );
  const evidence = { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" };
  const handoff = LIFE.rules[0];
  assert.deepEqual(messages(life(undefined, [handoff, evidence])), []);
  assert.ok(
    flags(
      life({ on: { ...LIFE.lifecycle.on, built: "done" } }),
      /^lifecycle\.on\.built sets "done", a done status; only "merged" may finish a task/,
    ),
  );
  const { commit, ...noCommit } = LIFE.lifecycle.write;
  assert.ok(
    flags(
      life({ write: noCommit }, [handoff, evidence]),
      /^lifecycle\.write\.commit is missing, but rules\[1\] \(done-has-evidence\) reads/,
    ),
  );
  const dated = life(undefined, [handoff, { rule: "done-signoff", kind: "task", field: "ok" }]);
  dated.kinds.task.fields.ok = { column: "OK", type: "date" };
  assert.ok(flags(dated, /^rules\[1\] \(done-signoff\) needs a dated sign-off on a done task/));
});
