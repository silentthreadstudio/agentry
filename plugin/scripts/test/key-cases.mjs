// The shared good/bad table for the harness keys (plan R1b §2.1): workflow.json `gate`, `extensions`,
// `conductor` (and the lifecycle `write` keys), the process file's own keys, a key put in the other
// file, and config.json `merge`, `lanes`. Each case is run through the plugin's validator
// (`spec-keys.test.mjs`, `config.test.mjs`) and, side by side with core's zod, in
// `packages/core/test/keys-parity.test.ts`: both must give the same verdict, naming the same paths.
// `bad` lists every path a bad case must name (`gate.command[1]`); a good case has none. Synthetic
// shapes only.
import { BOARD_KEYS, WORKFLOW_KEYS } from "../lib/process/spec.mjs";

/** A minimal valid process file the process cases add their board keys to. */
export const BASE = {
  version: 1,
  name: "Keys",
  root: "board",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
    },
  },
  rules: [{ rule: "ids-unique" }],
};

/** The two files of a case, as `validateSpec` takes them: BASE with the case's `board` keys (spread, so
 *  a `__proto__` key stays a plain own key), and its `workflow` (undefined: no workflow file). A
 *  `json` case gives its workflow file as JSON text. */
export const specOf = (c) => ({
  board: { ...structuredClone(BASE), ...structuredClone(c.board ?? {}) },
  workflow: c.json ? JSON.parse(c.json) : c.workflow && structuredClone(c.workflow),
});

const gate = (g) => ({ workflow: { gate: g } });
const life = (write) => ({ workflow: { lifecycle: { kind: "task", on: {}, write } } });
const checks = (c) => ({ workflow: { extensions: { merge: { checks: c } } } });

// BASE with a commits field `commit` carrying `join`.
const joined = (join) => ({
  board: {
    kinds: {
      task: {
        ...BASE.kinds.task,
        fields: { ...BASE.kinds.task.fields, commit: { column: "Commit", type: "commits", join } },
      },
    },
  },
});
const JOIN = "kinds.task.fields.commit.join";

// A key of one file put in the other: refused by its name, whatever it holds.
const MISPLACED = [
  ...WORKFLOW_KEYS.map((key) => ({
    name: `the workflow key ${key} in the process file`,
    board: { [key]: {} },
    bad: [key],
  })),
  ...BOARD_KEYS.map((key) => ({
    name: `the board key ${key} in the workflow file`,
    workflow: { [key]: {} },
    bad: [key],
  })),
];

export const PROCESS_CASES = [
  // good
  { name: "a space as a commits join", ...joined(" ") },
  { name: "a comma and space as a commits join", ...joined(", ") },
  { name: "a range mark as a commits join", ...joined("…") },
  { name: "a dotted range mark as a commits join", ...joined("..") },
  { name: "a gate with only a command", ...gate({ command: ["make", "test"] }) },
  {
    name: "a full gate",
    ...gate({
      command: ["tools/gate.sh"],
      quick: { command: ["tools/gate.sh", "--quick"], only: ["docs/**", "*.md"] },
      after: ["CHANGELOG.md"],
      concurrency: 2,
      flaky: ["test_budget"],
      flakyLogs: ["logs/*.log", "$TMPDIR/gate.*/tests.log"],
      note: "the repo's own gate",
    }),
  },
  { name: "an argv item with spaces", ...gate({ command: ["node", "--test", "a b"] }) },
  {
    name: "paths that normalise inside",
    ...gate({ command: ["x"], after: ["./docs/a.md", "a/../b.md"] }),
  },
  { name: "one merge check", ...checks(["repo-merge"]) },
  { name: "several merge checks", ...checks(["repo-merge", "a1", "0-x"]) },
  { name: "a conductor prompt", workflow: { conductor: { prompt: "docs/CONDUCTOR.md" } } },
  {
    name: "a conductor prompt and rules heading",
    workflow: { conductor: { prompt: "CONDUCTOR.md", rules: "Standing rules" } },
  },
  {
    name: "all three keys",
    workflow: {
      gate: { command: ["x"] },
      extensions: { merge: { checks: ["y"] } },
      conductor: { prompt: "z.md" },
    },
  },
  { name: "a lifecycle status write", ...life({ status: "status" }) },
  // bad: join
  { name: "an empty join", ...joined(""), bad: [JOIN] },
  { name: "a join with a letter", ...joined("x"), bad: [JOIN] },
  { name: "a join with a digit", ...joined(" 1 "), bad: [JOIN] },
  { name: "a join with a line break", ...joined(",\n"), bad: [JOIN] },
  { name: "a join with a carriage return", ...joined(", \r"), bad: [JOIN] },
  { name: "a join with a tab", ...joined("\t"), bad: [JOIN] },
  { name: "a join with a next-line character", ...joined("\u0085"), bad: [JOIN] },
  { name: "a join with a delete character", ...joined("\u007f"), bad: [JOIN] },
  { name: "a join that is not a string", ...joined(3), bad: [JOIN] },
  // bad: gate
  { name: "a gate as a string", ...gate("make test"), bad: ["gate"] },
  { name: "a gate as a list", ...gate(["make"]), bad: ["gate"] },
  { name: "a gate with no command", ...gate({}), bad: ["gate.command"] },
  { name: "a command as a string", ...gate({ command: "make test" }), bad: ["gate.command"] },
  { name: "an empty command", ...gate({ command: [] }), bad: ["gate.command"] },
  { name: "a non-string argv item", ...gate({ command: ["make", 1] }), bad: ["gate.command[1]"] },
  { name: "an empty argv item", ...gate({ command: ["make", ""] }), bad: ["gate.command[1]"] },
  { name: "a null argv item", ...gate({ command: [null] }), bad: ["gate.command[0]"] },
  {
    name: "a misspelled gate key",
    ...gate({ command: ["x"], comand: ["y"] }),
    bad: ["gate.comand"],
  },
  {
    name: "a quick tier without only",
    ...gate({ command: ["x"], quick: { command: ["x", "--quick"] } }),
    bad: ["gate.quick.only"],
  },
  {
    name: "a quick tier without a command",
    ...gate({ command: ["x"], quick: { only: ["docs/**"] } }),
    bad: ["gate.quick.command"],
  },
  {
    name: "a quick tier with an empty only",
    ...gate({ command: ["x"], quick: { command: ["x"], only: [] } }),
    bad: ["gate.quick.only"],
  },
  {
    name: "an absolute only glob",
    ...gate({ command: ["x"], quick: { command: ["x"], only: ["/etc/*"] } }),
    bad: ["gate.quick.only[0]"],
  },
  {
    name: "an only glob that climbs out",
    ...gate({ command: ["x"], quick: { command: ["x"], only: ["docs/**", "../x/**"] } }),
    bad: ["gate.quick.only[1]"],
  },
  {
    name: "an only glob as a string",
    ...gate({ command: ["x"], quick: { command: ["x"], only: "docs/**" } }),
    bad: ["gate.quick.only"],
  },
  {
    name: "a misspelled only",
    ...gate({ command: ["x"], quick: { command: ["x"], onyl: ["docs/**"] } }),
    bad: ["gate.quick.onyl", "gate.quick.only"],
  },
  {
    name: "a quick tier as a flag",
    ...gate({ command: ["x"], quick: "--quick" }),
    bad: ["gate.quick"],
  },
  {
    name: "a zero concurrency",
    ...gate({ command: ["x"], concurrency: 0 }),
    bad: ["gate.concurrency"],
  },
  { name: "an empty flaky list", ...gate({ command: ["x"], flaky: [] }), bad: ["gate.flaky"] },
  {
    name: "an empty flaky name",
    ...gate({ command: ["x"], flaky: ["a", ""] }),
    bad: ["gate.flaky[1]"],
  },
  {
    name: "an empty flakyLogs list",
    ...gate({ command: ["x"], flakyLogs: [] }),
    bad: ["gate.flakyLogs"],
  },
  {
    name: "flakyLogs globs that are absolute, climb out or are empty",
    ...gate({
      command: ["x"],
      flakyLogs: ["/var/log/a.log", "a/../b.log", "$TMPDIR/../x", "$TMPDIR/"],
    }),
    bad: ["gate.flakyLogs[0]", "gate.flakyLogs[1]", "gate.flakyLogs[2]", "gate.flakyLogs[3]"],
  },
  {
    name: "flakyLogs globs with a . segment",
    ...gate({ command: ["x"], flakyLogs: ["./sub/a.log", "sub/./a.log", "$TMPDIR/./a.log"] }),
    bad: ["gate.flakyLogs[0]", "gate.flakyLogs[1]", "gate.flakyLogs[2]"],
  },
  { name: "an empty after", ...gate({ command: ["x"], after: [] }), bad: ["gate.after"] },
  {
    name: "an after glob that climbs out",
    ...gate({ command: ["x"], after: ["a/../../x"] }),
    bad: ["gate.after[0]"],
  },
  {
    name: "an empty after glob",
    ...gate({ command: ["x"], after: [""] }),
    bad: ["gate.after[0]"],
  },
  { name: "an empty note", ...gate({ command: ["x"], note: "" }), bad: ["gate.note"] },
  { name: "a number note", ...gate({ command: ["x"], note: 5 }), bad: ["gate.note"] },
  {
    name: "a __proto__ key in the gate",
    json: '{ "gate": { "command": ["x"], "__proto__": { "after": [] } } }',
    bad: ["gate.__proto__"],
  },
  { name: "a misspelled top-level key", board: { gates: { command: ["x"] } }, bad: ["gates"] },
  // bad: extensions
  { name: "extensions with no merge", workflow: { extensions: {} }, bad: ["extensions.merge"] },
  {
    name: "a merge extension with no checks",
    workflow: { extensions: { merge: {} } },
    bad: ["extensions.merge.checks"],
  },
  { name: "an empty checks list names no repo check", ...checks([]) },
  { name: "checks as a string", ...checks("repo-merge"), bad: ["extensions.merge.checks"] },
  {
    name: "an upper-case skill name",
    ...checks(["Repo-Merge"]),
    bad: ["extensions.merge.checks[0]"],
  },
  {
    name: "a skill name with a leading -",
    ...checks(["-x"]),
    bad: ["extensions.merge.checks[0]"],
  },
  { name: "an empty skill name", ...checks(["a", ""]), bad: ["extensions.merge.checks[1]"] },
  {
    name: "a namespaced skill name",
    ...checks(["repo:merge"]),
    bad: ["extensions.merge.checks[0]"],
  },
  {
    name: "a repeated skill name",
    ...checks(["a", "b", "a"]),
    bad: ["extensions.merge.checks[2]"],
  },
  {
    name: "a misspelled checks",
    workflow: { extensions: { merge: { check: ["a"] } } },
    bad: ["extensions.merge.check", "extensions.merge.checks"],
  },
  {
    name: "a misspelled merge",
    workflow: { extensions: { marge: { checks: ["a"] } } },
    bad: ["extensions.marge", "extensions.merge"],
  },
  // bad: conductor
  { name: "a conductor with no prompt", workflow: { conductor: {} }, bad: ["conductor.prompt"] },
  {
    name: "an empty prompt path",
    workflow: { conductor: { prompt: "" } },
    bad: ["conductor.prompt"],
  },
  {
    name: "an absolute prompt path",
    workflow: { conductor: { prompt: "/home/x/CONDUCTOR.md" } },
    bad: ["conductor.prompt"],
  },
  {
    name: "a prompt path out",
    workflow: { conductor: { prompt: "../CONDUCTOR.md" } },
    bad: ["conductor.prompt"],
  },
  {
    name: "an empty rules heading",
    workflow: { conductor: { prompt: "C.md", rules: "" } },
    bad: ["conductor.rules"],
  },
  {
    name: "a rules heading as a list",
    workflow: { conductor: { prompt: "C.md", rules: ["Rules"] } },
    bad: ["conductor.rules"],
  },
  {
    name: "a misspelled prompt",
    workflow: { conductor: { promt: "C.md" } },
    bad: ["conductor.promt", "conductor.prompt"],
  },
  // worktrees.keep and the hand status file
  { name: "worktrees to keep", workflow: { worktrees: { keep: ["main-*", "docs"] } } },
  { name: "an empty keep list", workflow: { worktrees: { keep: [] } }, bad: ["worktrees.keep"] },
  {
    name: "a keep entry that is empty",
    workflow: { worktrees: { keep: [""] } },
    bad: ["worktrees.keep[0]"],
  },
  { name: "worktrees with no keep", workflow: { worktrees: {} }, bad: ["worktrees.keep"] },
  // guard.allow
  { name: "guard globs", workflow: { guard: { allow: ["docs/STATUS.md", "docs/plans/**"] } } },
  { name: "an empty allow list", workflow: { guard: { allow: [] } }, bad: ["guard.allow"] },
  { name: "guard with no allow", workflow: { guard: {} }, bad: ["guard.allow"] },
  {
    name: "an allow glob out of the repository",
    workflow: { guard: { allow: ["../x.md", "/abs.md"] } },
    bad: ["guard.allow[0]", "guard.allow[1]"],
  },
  {
    name: "a misspelled allow",
    workflow: { guard: { alow: ["docs/**"] } },
    bad: ["guard.alow", "guard.allow"],
  },
  // cleanup.disposable
  {
    name: "disposable globs",
    workflow: { cleanup: { disposable: ["**/.godot", "**/*.translation"] } },
  },
  {
    name: "an empty disposable list",
    workflow: { cleanup: { disposable: [] } },
    bad: ["cleanup.disposable"],
  },
  {
    name: "a disposable entry that is empty",
    workflow: { cleanup: { disposable: [""] } },
    bad: ["cleanup.disposable[0]"],
  },
  {
    name: "a disposable glob out of the repository",
    workflow: { cleanup: { disposable: ["../build"] } },
    bad: ["cleanup.disposable[0]"],
  },
  {
    name: "a hand status file and its heading",
    board: { status: { file: "docs/STATUS.md", next: "Next" } },
  },
  {
    name: "a status file outside the repository",
    board: { status: { file: "../STATUS.md" } },
    bad: ["status.file"],
  },
  { name: "an empty status heading", board: { status: { next: "" } }, bad: ["status.next"] },
  // bad: lifecycle writes
  {
    name: "a misspelled lifecycle write",
    ...life({ verdit: "status" }),
    bad: ["lifecycle.write.verdit"],
  },
  {
    name: "a handoff write that is no parent section",
    ...life({ handoff: "handoff" }),
    bad: ["lifecycle.write.handoff"],
  },
  ...MISPLACED,
];

export const CONFIG_CASES = [
  // good
  { name: "no keys", value: {} },
  { name: "an empty merge block", value: { merge: {} } },
  { name: "push ask", value: { merge: { push: "ask" } } },
  { name: "push auto", value: { merge: { push: "auto" } } },
  { name: "push never", value: { merge: { push: "never" } } },
  { name: "an empty lanes block", value: { lanes: {} } },
  { name: "one writer", value: { lanes: { maxWriters: 1 } } },
  { name: "many writers", value: { lanes: { maxWriters: 12 } } },
  { name: "beside other keys", value: { memory: { prime: "all" }, merge: { push: "never" } } },
  { name: "every top-level key there is", value: { workDir: "x", evolution: {}, memory: {} } },
  { name: "a night mode", value: { mode: "night" } },
  { name: "any mode name", value: { mode: "away-2" } },
  // bad
  { name: "a misspelled merge block", value: { marge: { push: "never" } }, bad: ["marge"] },
  { name: "a misspelled lanes block", value: { lane: { maxWriters: 1 } }, bad: ["lane"] },
  { name: "an unknown top-level key", value: { telemetry: true }, bad: ["telemetry"] },
  { name: "a mode as a number", value: { mode: 1 }, bad: ["mode"] },
  { name: "an empty mode", value: { mode: "" }, bad: ["mode"] },
  { name: "an unknown push", value: { merge: { push: "yes" } }, bad: ["merge.push"] },
  { name: "an empty push", value: { merge: { push: "" } }, bad: ["merge.push"] },
  { name: "an upper-case push", value: { merge: { push: "AUTO" } }, bad: ["merge.push"] },
  { name: "push as true", value: { merge: { push: true } }, bad: ["merge.push"] },
  { name: "merge as a string", value: { merge: "ask" }, bad: ["merge"] },
  { name: "merge as null", value: { merge: null }, bad: ["merge"] },
  { name: "a misspelled push", value: { merge: { pushh: "auto" } }, bad: ["merge.pushh"] },
  { name: "zero writers", value: { lanes: { maxWriters: 0 } }, bad: ["lanes.maxWriters"] },
  { name: "negative writers", value: { lanes: { maxWriters: -1 } }, bad: ["lanes.maxWriters"] },
  { name: "fractional writers", value: { lanes: { maxWriters: 2.5 } }, bad: ["lanes.maxWriters"] },
  { name: "writers as a string", value: { lanes: { maxWriters: "3" } }, bad: ["lanes.maxWriters"] },
  { name: "writers as null", value: { lanes: { maxWriters: null } }, bad: ["lanes.maxWriters"] },
  { name: "lanes as a list", value: { lanes: [3] }, bad: ["lanes"] },
  { name: "a misspelled maxWriters", value: { lanes: { max: 3 } }, bad: ["lanes.max"] },
  {
    name: "a __proto__ key in merge",
    json: '{ "merge": { "__proto__": { "push": "auto" } } }',
    bad: ["merge.__proto__"],
  },
];

/** The config value of a case. */
export const configOf = (c) => (c.json ? JSON.parse(c.json) : structuredClone(c.value));

/** A validator message's path: the text before its first space (`gate.command[1] should be …`). */
export const pathOf = (message) => message.split(" ")[0];
