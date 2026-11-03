// The shared good/bad table for the harness keys (plan R1b §2.1): workflow.json `gate`, `extensions`,
// `conductor` (and the lifecycle `write` keys), the process file's own keys, a key put in the other
// file, and config.json `merge`, `lanes`. Each case is run through the plugin's validator
// (`spec-keys.test.mjs`, `config.test.mjs`) and, side by side with core's zod, in
// `packages/core/test/keys-parity.test.ts`: both must give the same verdict, naming the same paths.
// `bad` lists every path a bad case must name (`gate.tiers[0].command[1]`); a good case has none. Synthetic
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
const tier = (name, command, when) => ({ name, command, ...(when !== undefined && { when }) });
// The plainest valid tiers: one fallback tier.
const T = [tier("full", ["x"])];
const life = (write) => ({ workflow: { lifecycle: { kind: "task", on: {}, write } } });
const briefs = (b) => ({ workflow: { briefs: b } });
const commits = (c) => ({ workflow: { commits: c } });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const checks = (c) => ({ workflow: { extensions: { merge: { checks: c } } } });
const ext = (e) => ({ workflow: { extensions: e } });

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

// BASE with a debt kind beside the task kind and the lifecycle on tasks, and `entry` as `exec.kinds`:
// what the exec-kinds cases change one piece of. `kinds` adds kinds, `rules` rule entries, `exec` other
// exec keys; `lifecycle: null` leaves the lifecycle out.
const DEBT = {
  label: "Debt",
  at: { table: "BOARD.md", heading: "Debt" },
  id: { column: "Debt" },
  fields: {
    status: { column: "Status" },
    verdict: { column: "Verdict" },
    commit: { column: "Commit", type: "commits" },
  },
  status: {
    field: "status",
    values: { todo: "planned", doing: "active", verify: "active", done: "done" },
  },
};
const ON = { dispatched: "doing", built: "verify", failed: "doing", merged: "done" };
const WRITE = { status: "status", verdict: "verdict", commit: "commit" };
const execKinds = (entry, { kinds = {}, rules = [], exec = {}, lifecycle } = {}) => ({
  board: { kinds: { ...BASE.kinds, debt: DEBT, ...kinds }, rules: [...BASE.rules, ...rules] },
  workflow: {
    ...(lifecycle === null ? {} : { lifecycle: lifecycle ?? { kind: "task", on: {} } }),
    exec: { ...exec, kinds: entry },
  },
});
const debt = (entry) => execKinds({ debt: entry });

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
  { name: "a gate with one tier", ...gate({ tiers: [tier("full", ["make", "test"])] }) },
  {
    name: "a full gate",
    ...gate({
      tiers: [
        tier("docs", ["scripts/gate.sh", "--quick"], { only: ["docs/**", "*.md"] }),
        tier("tests", ["scripts/gate.sh", "--tests"], { only: ["src/ui/**", "tests/**"] }),
        tier("full", ["scripts/gate.sh"]),
      ],
      roles: { build: "pick", verify: "none", merge: "pick" },
      checklist: [
        {
          name: "ui-smoke",
          text: "Open each changed screen; no errors in the console",
          when: { any: ["src/ui/**"], flag: true },
        },
      ],
      after: ["CHANGELOG.md"],
      concurrency: 2,
      flaky: ["test_budget"],
      flakyLogs: ["logs/*.log", "$TMPDIR/gate.*/tests.log"],
      note: "the repo's own gate",
    }),
  },
  {
    name: "roles naming a tier, full and pick, and a last tier not called full",
    ...gate({
      tiers: [tier("ui", ["x", "--ui"], { flag: true }), tier("ci", ["x"])],
      roles: { build: "ui", verify: "full", merge: "pick" },
    }),
  },
  { name: "a verify role of none alone", ...gate({ tiers: T, roles: { verify: "none" } }) },
  {
    name: "a checklist item with no when",
    ...gate({ tiers: T, checklist: [{ name: "owner-ok", text: "The owner saw it run" }] }),
  },
  {
    name: "an argv item with spaces",
    ...gate({ tiers: [tier("full", ["node", "--test", "a b"])] }),
  },
  {
    name: "paths that normalise inside",
    ...gate({ tiers: T, after: ["./docs/a.md", "a/../b.md"] }),
  },
  { name: "one merge check", ...checks(["repo-merge"]) },
  { name: "several merge checks", ...checks(["repo-merge", "a1", "0-x"]) },
  { name: "a start extension only", ...ext({ start: { checks: ["repo-session"] } }) },
  { name: "a close extension only", ...ext({ close: { checks: ["repo-session"] } }) },
  {
    name: "one session skill at start and at close",
    ...ext({ start: { checks: ["repo-session"] }, close: { checks: ["repo-session"] } }),
  },
  { name: "an empty start checks list", ...ext({ start: { checks: [] } }) },
  { name: "a conductor prompt", workflow: { conductor: { prompt: "docs/CONDUCTOR.md" } } },
  {
    name: "a conductor prompt and rules heading",
    workflow: { conductor: { prompt: "CONDUCTOR.md", rules: "Standing rules" } },
  },
  {
    name: "all three keys",
    workflow: {
      gate: { tiers: T },
      extensions: { merge: { checks: ["y"] } },
      conductor: { prompt: "z.md" },
    },
  },
  { name: "a lifecycle status write", ...life({ status: "status" }) },
  { name: "build policy lines", ...briefs({ build: ["Use pnpm.", "Run `make lint` | `{{id}}`"] }) },
  { name: "verify policy lines", ...briefs({ verify: ["Check the changelog."] }) },
  { name: "both policy lists", ...briefs({ build: ["a"], verify: ["b"] }) },
  { name: "an empty briefs block", ...briefs({}) },
  { name: "twenty policy lines", ...briefs({ build: lines(20) }) },
  { name: "an empty commits block", ...commits({}) },
  {
    name: "every commits rule",
    ...commits({
      subjectMax: 72,
      subjectPattern: "^(feat|fix): .+",
      forbid: ["^Co-Authored-By:", "x"],
    }),
  },
  { name: "a debt kind exec runs", ...debt({ on: ON, write: WRITE }) },
  { name: "an exec kind with only its events", ...debt({ on: { dispatched: "doing" } }) },
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
  { name: "a gate with no tiers", ...gate({}), bad: ["gate.tiers"] },
  {
    name: "an old gate.command beside tiers",
    ...gate({ tiers: T, command: ["make", "test"] }),
    bad: ["gate.command"],
  },
  {
    name: "an old gate with only a command",
    ...gate({ command: ["make", "test"] }),
    bad: ["gate.command", "gate.tiers"],
  },
  {
    name: "an old quick tier",
    ...gate({ tiers: T, quick: { command: ["x", "--quick"], only: ["docs/**"] } }),
    bad: ["gate.quick"],
  },
  { name: "tiers as an object", ...gate({ tiers: tier("full", ["x"]) }), bad: ["gate.tiers"] },
  { name: "an empty tiers list", ...gate({ tiers: [] }), bad: ["gate.tiers"] },
  {
    name: "a tier with no command",
    ...gate({ tiers: [{ name: "full" }] }),
    bad: ["gate.tiers[0].command"],
  },
  {
    name: "a tier with no name",
    ...gate({ tiers: [{ command: ["x"] }] }),
    bad: ["gate.tiers[0].name"],
  },
  {
    name: "a command as a string",
    ...gate({ tiers: [tier("full", "make test")] }),
    bad: ["gate.tiers[0].command"],
  },
  {
    name: "an empty command",
    ...gate({ tiers: [tier("full", [])] }),
    bad: ["gate.tiers[0].command"],
  },
  {
    name: "a non-string argv item",
    ...gate({ tiers: [tier("full", ["make", 1])] }),
    bad: ["gate.tiers[0].command[1]"],
  },
  {
    name: "an empty argv item",
    ...gate({ tiers: [tier("full", ["make", ""])] }),
    bad: ["gate.tiers[0].command[1]"],
  },
  {
    name: "a null argv item",
    ...gate({ tiers: [tier("full", [null])] }),
    bad: ["gate.tiers[0].command[0]"],
  },
  {
    name: "two tiers with one name",
    ...gate({ tiers: [tier("docs", ["x"], { only: ["docs/**"] }), tier("docs", ["x"])] }),
    bad: ["gate.tiers[1].name"],
  },
  {
    name: "full that is not the last tier",
    ...gate({ tiers: [tier("full", ["x"], { only: ["docs/**"] }), tier("ci", ["x"])] }),
    bad: ["gate.tiers[0].name"],
  },
  {
    name: "a tier named pick",
    ...gate({ tiers: [tier("pick", ["x"])] }),
    bad: ["gate.tiers[0].name"],
  },
  {
    name: "a tier named none",
    ...gate({ tiers: [tier("none", ["x"])] }),
    bad: ["gate.tiers[0].name"],
  },
  {
    name: "an upper-case tier name",
    ...gate({ tiers: [tier("Docs", ["x"])] }),
    bad: ["gate.tiers[0].name"],
  },
  {
    name: "a last tier with a when",
    ...gate({ tiers: [tier("full", ["x"], { only: ["docs/**"] })] }),
    bad: ["gate.tiers[0].when"],
  },
  {
    name: "an earlier tier with no when",
    ...gate({ tiers: [tier("docs", ["x"]), tier("full", ["x"])] }),
    bad: ["gate.tiers[0].when"],
  },
  {
    name: "an empty when",
    ...gate({ tiers: [tier("docs", ["x"], {}), tier("full", ["x"])] }),
    bad: ["gate.tiers[0].when"],
  },
  {
    name: "a flag of false",
    ...gate({ tiers: [tier("ui", ["x"], { flag: false }), tier("full", ["x"])] }),
    bad: ["gate.tiers[0].when.flag"],
  },
  {
    name: "a misspelled when key",
    ...gate({ tiers: [tier("docs", ["x"], { onyl: ["docs/**"] }), tier("full", ["x"])] }),
    bad: ["gate.tiers[0].when.onyl", "gate.tiers[0].when"],
  },
  {
    name: "an absolute only glob",
    ...gate({ tiers: [tier("docs", ["x"], { only: ["/etc/*"] }), tier("full", ["x"])] }),
    bad: ["gate.tiers[0].when.only[0]"],
  },
  {
    name: "an any glob that climbs out",
    ...gate({ tiers: [tier("ui", ["x"], { any: ["src/**", "../x/**"] }), tier("full", ["x"])] }),
    bad: ["gate.tiers[0].when.any[1]"],
  },
  {
    name: "an empty only list",
    ...gate({ tiers: [tier("docs", ["x"], { only: [] }), tier("full", ["x"])] }),
    bad: ["gate.tiers[0].when.only"],
  },
  {
    name: "a role naming no tier",
    ...gate({ tiers: T, roles: { merge: "docs" } }),
    bad: ["gate.roles.merge"],
  },
  {
    name: "a build role of none",
    ...gate({ tiers: T, roles: { build: "none" } }),
    bad: ["gate.roles.build"],
  },
  {
    name: "a misspelled role",
    ...gate({ tiers: T, roles: { biuld: "pick" } }),
    bad: ["gate.roles.biuld"],
  },
  {
    name: "a role as a list",
    ...gate({ tiers: T, roles: { build: ["full"] } }),
    bad: ["gate.roles.build"],
  },
  {
    name: "a checklist name repeated",
    ...gate({
      tiers: T,
      checklist: [
        { name: "ui-smoke", text: "a" },
        { name: "ui-smoke", text: "b" },
      ],
    }),
    bad: ["gate.checklist[1].name"],
  },
  {
    name: "a checklist name that is a merge check",
    workflow: {
      gate: { tiers: T, checklist: [{ name: "repo-merge", text: "a" }] },
      extensions: { merge: { checks: ["repo-merge"] } },
    },
    bad: ["gate.checklist[0].name"],
  },
  {
    name: "a checklist item with no text",
    ...gate({ tiers: T, checklist: [{ name: "ui-smoke" }] }),
    bad: ["gate.checklist[0].text"],
  },
  { name: "an empty checklist", ...gate({ tiers: T, checklist: [] }), bad: ["gate.checklist"] },
  {
    name: "a misspelled gate key",
    ...gate({ tiers: T, comand: ["y"] }),
    bad: ["gate.comand"],
  },
  { name: "a zero concurrency", ...gate({ tiers: T, concurrency: 0 }), bad: ["gate.concurrency"] },
  { name: "an empty flaky list", ...gate({ tiers: T, flaky: [] }), bad: ["gate.flaky"] },
  { name: "an empty flaky name", ...gate({ tiers: T, flaky: ["a", ""] }), bad: ["gate.flaky[1]"] },
  {
    name: "an empty flakyLogs list",
    ...gate({ tiers: T, flakyLogs: [] }),
    bad: ["gate.flakyLogs"],
  },
  {
    name: "flakyLogs globs that are absolute, climb out or are empty",
    ...gate({
      tiers: T,
      flakyLogs: ["/var/log/a.log", "a/../b.log", "$TMPDIR/../x", "$TMPDIR/"],
    }),
    bad: ["gate.flakyLogs[0]", "gate.flakyLogs[1]", "gate.flakyLogs[2]", "gate.flakyLogs[3]"],
  },
  {
    name: "flakyLogs globs with a . segment",
    ...gate({ tiers: T, flakyLogs: ["./sub/a.log", "sub/./a.log", "$TMPDIR/./a.log"] }),
    bad: ["gate.flakyLogs[0]", "gate.flakyLogs[1]", "gate.flakyLogs[2]"],
  },
  { name: "an empty after", ...gate({ tiers: T, after: [] }), bad: ["gate.after"] },
  {
    name: "an after glob that climbs out",
    ...gate({ tiers: T, after: ["a/../../x"] }),
    bad: ["gate.after[0]"],
  },
  { name: "an empty after glob", ...gate({ tiers: T, after: [""] }), bad: ["gate.after[0]"] },
  { name: "an empty note", ...gate({ tiers: T, note: "" }), bad: ["gate.note"] },
  { name: "a number note", ...gate({ tiers: T, note: 5 }), bad: ["gate.note"] },
  {
    name: "a __proto__ key in the gate",
    json: '{ "gate": { "tiers": [{ "name": "full", "command": ["x"] }], "__proto__": { "after": [] } } }',
    bad: ["gate.__proto__"],
  },
  { name: "a misspelled top-level key", board: { gates: { command: ["x"] } }, bad: ["gates"] },
  // bad: extensions
  { name: "extensions naming no phase", ...ext({}), bad: ["extensions"] },
  {
    name: "a start extension with no checks",
    ...ext({ start: {} }),
    bad: ["extensions.start.checks"],
  },
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
    bad: ["extensions.marge", "extensions"],
  },
  {
    name: "an unknown extensions phase beside a good one",
    ...ext({ merge: { checks: ["a"] }, session: { checks: ["a"] } }),
    bad: ["extensions.session"],
  },
  {
    name: "a start check with a bad skill name",
    ...ext({ start: { checks: ["Repo-Start"] } }),
    bad: ["extensions.start.checks[0]"],
  },
  {
    name: "a repeated close check",
    ...ext({ close: { checks: ["a", "a"] } }),
    bad: ["extensions.close.checks[1]"],
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
  // bad: briefs and commits
  { name: "briefs as a list", ...briefs(["a"]), bad: ["briefs"] },
  { name: "a misspelled briefs key", ...briefs({ builds: ["a"] }), bad: ["briefs.builds"] },
  { name: "an empty policy list", ...briefs({ build: [] }), bad: ["briefs.build"] },
  { name: "a policy list as a string", ...briefs({ verify: "a" }), bad: ["briefs.verify"] },
  { name: "twenty-one policy lines", ...briefs({ build: lines(21) }), bad: ["briefs.build"] },
  { name: "an empty policy line", ...briefs({ build: ["a", ""] }), bad: ["briefs.build[1]"] },
  {
    name: "a policy line that is not a string",
    ...briefs({ build: [3] }),
    bad: ["briefs.build[0]"],
  },
  {
    name: "a policy line with a line break",
    ...briefs({ verify: ["a\nb"] }),
    bad: ["briefs.verify[0]"],
  },
  {
    name: "a policy line with a carriage return",
    ...briefs({ build: ["a\rb"] }),
    bad: ["briefs.build[0]"],
  },
  { name: "commits as a list", ...commits(["a"]), bad: ["commits"] },
  { name: "a misspelled commits key", ...commits({ subjectMx: 72 }), bad: ["commits.subjectMx"] },
  { name: "a zero subjectMax", ...commits({ subjectMax: 0 }), bad: ["commits.subjectMax"] },
  { name: "a fractional subjectMax", ...commits({ subjectMax: 7.5 }), bad: ["commits.subjectMax"] },
  {
    name: "a subjectMax as a string",
    ...commits({ subjectMax: "72" }),
    bad: ["commits.subjectMax"],
  },
  {
    name: "an invalid subjectPattern",
    ...commits({ subjectPattern: "(" }),
    bad: ["commits.subjectPattern"],
  },
  {
    name: "an empty subjectPattern",
    ...commits({ subjectPattern: "" }),
    bad: ["commits.subjectPattern"],
  },
  { name: "an empty forbid list", ...commits({ forbid: [] }), bad: ["commits.forbid"] },
  { name: "an empty forbid entry", ...commits({ forbid: ["a", ""] }), bad: ["commits.forbid[1]"] },
  {
    name: "an invalid forbid entry",
    ...commits({ forbid: ["a", "["] }),
    bad: ["commits.forbid[1]"],
  },
  { name: "forbid as a string", ...commits({ forbid: "a" }), bad: ["commits.forbid"] },
  // bad: an exec.kinds entry is the lifecycle mapping with no kind and no handoff
  {
    name: "an exec kind entry naming its kind",
    ...debt({ kind: "debt", on: ON }),
    bad: ["exec.kinds.debt.kind"],
  },
  {
    name: "an exec kind entry with a handoff template",
    ...debt({ on: ON, handoff: "- **{id}**" }),
    bad: ["exec.kinds.debt.handoff"],
  },
  {
    name: "an exec kind entry writing a handoff",
    ...debt({ on: ON, write: { ...WRITE, handoff: "parent.file:handoff" } }),
    bad: ["exec.kinds.debt.write.handoff"],
  },
  { name: "an exec kind entry with no on", ...debt({ write: WRITE }), bad: ["exec.kinds.debt.on"] },
  { name: "exec kinds as a list", ...execKinds(["debt"]), bad: ["exec.kinds"] },
  ...MISPLACED,
];

/** The `exec.kinds` refusals that read both files (`spec/across.mjs`): no zod parity, as core's
 *  `Workflow` never sees the board. Each names its paths (`bad`) and the file that holds them. */
export const ACROSS_CASES = [
  {
    name: "an exec kind that is not declared",
    ...execKinds({ chore: { on: {} } }),
    bad: ["exec.kinds.chore"],
    file: "workflow.json",
  },
  {
    name: "the lifecycle kind as an exec kind",
    ...execKinds({ task: { on: {} } }),
    bad: ["exec.kinds.task"],
    file: "workflow.json",
  },
  {
    name: "exec kinds with no lifecycle",
    ...execKinds({ debt: { on: ON, write: WRITE } }, { lifecycle: null }),
    bad: ["exec.kinds"],
    file: "workflow.json",
  },
  {
    name: "an exec kind with a parent field",
    ...execKinds(
      { debt: { on: ON } },
      {
        kinds: {
          debt: {
            ...DEBT,
            fields: {
              ...DEBT.fields,
              of: { column: "Of", type: "ref", ref: "task", role: "parent" },
            },
          },
        },
      },
    ),
    bad: ["exec.kinds.debt"],
    file: "workflow.json",
  },
  {
    name: "empty exec kinds with no lifecycle",
    ...execKinds({}, { lifecycle: null }),
    bad: ["exec.kinds"],
    file: "workflow.json",
  },
  {
    name: "an exec kind that is another kind's parent",
    ...execKinds(
      { debt: { on: ON } },
      {
        kinds: {
          chore: {
            ...DEBT,
            at: { table: "BOARD.md", heading: "Chores" },
            id: { column: "Chore" },
            fields: {
              ...DEBT.fields,
              of: { column: "Of", type: "ref", ref: "debt", role: "parent" },
            },
          },
        },
      },
    ),
    bad: ["exec.kinds.debt"],
    file: "workflow.json",
  },
  {
    name: "an exec kind that another kind lists as children",
    ...execKinds(
      { debt: { on: ON } },
      {
        kinds: {
          chore: {
            ...DEBT,
            at: { table: "BOARD.md", heading: "Chores" },
            id: { column: "Chore" },
            fields: {
              ...DEBT.fields,
              items: { column: "Items", type: "list", ref: "debt", role: "children" },
            },
          },
        },
      },
    ),
    bad: ["exec.kinds.debt"],
    file: "workflow.json",
  },
  {
    name: "an exec kind with a children list of its own",
    ...execKinds(
      { debt: { on: ON } },
      {
        kinds: {
          debt: {
            ...DEBT,
            fields: {
              ...DEBT.fields,
              items: { column: "Items", type: "list", ref: "chore", role: "children" },
            },
          },
          chore: {
            ...DEBT,
            at: { table: "BOARD.md", heading: "Chores" },
            id: { column: "Chore" },
            fields: {
              ...DEBT.fields,
              of: { column: "Of", type: "ref", ref: "debt", role: "parent" },
            },
          },
        },
      },
    ),
    bad: ["exec.kinds.debt"],
    file: "workflow.json",
  },
  {
    name: "an exec kind event naming no status of its kind",
    ...debt({ on: { ...ON, built: "review" } }),
    bad: ["exec.kinds.debt.on.built"],
    file: "workflow.json",
  },
  {
    name: "an exec kind writing its status to another field",
    ...debt({ on: ON, write: { ...WRITE, status: "verdict" } }),
    bad: ["exec.kinds.debt.write.status"],
    file: "workflow.json",
  },
  {
    name: "an exec kind writing its verdict to no field",
    ...debt({ on: ON, write: { ...WRITE, verdict: "grade" } }),
    bad: ["exec.kinds.debt.write.verdict"],
    file: "workflow.json",
  },
  {
    name: "an exec kind writing its commits to a text field",
    ...debt({ on: ON, write: { ...WRITE, commit: "verdict" } }),
    bad: ["exec.kinds.debt.write.commit"],
    file: "workflow.json",
  },
  {
    name: "an exec kind finished by another event than merged",
    ...debt({ on: { ...ON, built: "done" } }),
    bad: ["exec.kinds.debt.on.built"],
    file: "workflow.json",
  },
  {
    name: "an exec kind that leaves out the commits done-has-evidence reads",
    ...execKinds(
      { debt: { on: ON, write: { status: "status" } } },
      { rules: [{ rule: "done-has-evidence", kind: "debt", field: "commit", evidence: "commit" }] },
    ),
    bad: ["exec.kinds.debt.write.commit"],
    file: "workflow.json",
  },
  {
    name: "a dated sign-off on an exec kind",
    ...execKinds(
      { debt: { on: ON, write: WRITE } },
      {
        kinds: {
          debt: {
            ...DEBT,
            fields: { ...DEBT.fields, signoff: { column: "Signed", type: "date" } },
          },
        },
        rules: [{ rule: "done-signoff", kind: "debt", field: "signoff" }],
      },
    ),
    bad: ["rules[1]"],
    file: "process.json",
  },
  {
    name: "verify flagged with no flag field on an exec kind",
    ...execKinds(
      { debt: { on: ON, write: WRITE } },
      {
        kinds: {
          task: {
            ...BASE.kinds.task,
            fields: { ...BASE.kinds.task.fields, flag: { column: "Flag", type: "flag" } },
          },
        },
        exec: { verify: "flagged" },
      },
    ),
    bad: ["exec.verify"],
    file: "workflow.json",
  },
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

/** A validator message's path: the text before its first space (`gate.tiers[0].command[1] should be …`). */
export const pathOf = (message) => message.split(" ")[0];
