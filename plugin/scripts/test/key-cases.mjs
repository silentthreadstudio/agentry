// The shared good/bad table for the harness keys (plan R1b §2.1): process.json `gate`, `extensions`,
// `conductor` (and the lifecycle `write` keys), config.json `merge`, `lanes`. Each case is run
// through the plugin's validator (`spec-keys.test.mjs`, `config.test.mjs`) and, side by side with
// core's zod, in `packages/core/test/keys-parity.test.ts`: both must give the same verdict, naming
// the same paths. `bad` lists every path a bad case must name (`gate.command[1]`); a good case has
// none. Synthetic shapes only.

/** A minimal valid process file the process cases add their keys to. */
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

/** The process file of a case: BASE with the case's top-level keys (spread, so a `__proto__` key
 *  parsed from JSON stays a plain own key). */
export const processOf = (c) => ({
  ...structuredClone(BASE),
  ...(c.json ? JSON.parse(c.json) : c.add),
});

const gate = (g) => ({ gate: g });
const life = (write) => ({ lifecycle: { kind: "task", on: {}, write } });
const checks = (c) => ({ extensions: { merge: { checks: c } } });

export const PROCESS_CASES = [
  // good
  { name: "a gate with only a command", add: gate({ command: ["make", "test"] }) },
  {
    name: "a full gate",
    add: gate({
      command: ["tools/gate.sh"],
      quick: { command: ["tools/gate.sh", "--quick"], only: ["docs/**", "*.md"] },
      after: ["CHANGELOG.md"],
      note: "the repo's own gate",
    }),
  },
  { name: "an argv item with spaces", add: gate({ command: ["node", "--test", "a b"] }) },
  {
    name: "paths that normalise inside",
    add: gate({ command: ["x"], after: ["./docs/a.md", "a/../b.md"] }),
  },
  { name: "one merge check", add: checks(["repo-merge"]) },
  { name: "several merge checks", add: checks(["repo-merge", "a1", "0-x"]) },
  { name: "a conductor prompt", add: { conductor: { prompt: "docs/CONDUCTOR.md" } } },
  {
    name: "a conductor prompt and rules heading",
    add: { conductor: { prompt: "CONDUCTOR.md", rules: "Standing rules" } },
  },
  {
    name: "all three keys",
    add: { ...gate({ command: ["x"] }), ...checks(["y"]), conductor: { prompt: "z.md" } },
  },
  { name: "a lifecycle status write", add: life({ status: "status" }) },
  // bad: gate
  { name: "a gate as a string", add: gate("make test"), bad: ["gate"] },
  { name: "a gate as a list", add: gate(["make"]), bad: ["gate"] },
  { name: "a gate with no command", add: gate({}), bad: ["gate.command"] },
  { name: "a command as a string", add: gate({ command: "make test" }), bad: ["gate.command"] },
  { name: "an empty command", add: gate({ command: [] }), bad: ["gate.command"] },
  { name: "a non-string argv item", add: gate({ command: ["make", 1] }), bad: ["gate.command[1]"] },
  { name: "an empty argv item", add: gate({ command: ["make", ""] }), bad: ["gate.command[1]"] },
  { name: "a null argv item", add: gate({ command: [null] }), bad: ["gate.command[0]"] },
  {
    name: "a misspelled gate key",
    add: gate({ command: ["x"], comand: ["y"] }),
    bad: ["gate.comand"],
  },
  {
    name: "a quick tier without only",
    add: gate({ command: ["x"], quick: { command: ["x", "--quick"] } }),
    bad: ["gate.quick.only"],
  },
  {
    name: "a quick tier without a command",
    add: gate({ command: ["x"], quick: { only: ["docs/**"] } }),
    bad: ["gate.quick.command"],
  },
  {
    name: "a quick tier with an empty only",
    add: gate({ command: ["x"], quick: { command: ["x"], only: [] } }),
    bad: ["gate.quick.only"],
  },
  {
    name: "an absolute only glob",
    add: gate({ command: ["x"], quick: { command: ["x"], only: ["/etc/*"] } }),
    bad: ["gate.quick.only[0]"],
  },
  {
    name: "an only glob that climbs out",
    add: gate({ command: ["x"], quick: { command: ["x"], only: ["docs/**", "../x/**"] } }),
    bad: ["gate.quick.only[1]"],
  },
  {
    name: "an only glob as a string",
    add: gate({ command: ["x"], quick: { command: ["x"], only: "docs/**" } }),
    bad: ["gate.quick.only"],
  },
  {
    name: "a misspelled only",
    add: gate({ command: ["x"], quick: { command: ["x"], onyl: ["docs/**"] } }),
    bad: ["gate.quick.onyl", "gate.quick.only"],
  },
  {
    name: "a quick tier as a flag",
    add: gate({ command: ["x"], quick: "--quick" }),
    bad: ["gate.quick"],
  },
  { name: "an empty after", add: gate({ command: ["x"], after: [] }), bad: ["gate.after"] },
  {
    name: "an after glob that climbs out",
    add: gate({ command: ["x"], after: ["a/../../x"] }),
    bad: ["gate.after[0]"],
  },
  {
    name: "an empty after glob",
    add: gate({ command: ["x"], after: [""] }),
    bad: ["gate.after[0]"],
  },
  { name: "an empty note", add: gate({ command: ["x"], note: "" }), bad: ["gate.note"] },
  { name: "a number note", add: gate({ command: ["x"], note: 5 }), bad: ["gate.note"] },
  {
    name: "a __proto__ key in the gate",
    json: '{ "gate": { "command": ["x"], "__proto__": { "after": [] } } }',
    bad: ["gate.__proto__"],
  },
  { name: "a misspelled top-level key", add: { gates: { command: ["x"] } }, bad: ["gates"] },
  // bad: extensions
  { name: "extensions with no merge", add: { extensions: {} }, bad: ["extensions.merge"] },
  {
    name: "a merge extension with no checks",
    add: { extensions: { merge: {} } },
    bad: ["extensions.merge.checks"],
  },
  { name: "an empty checks list", add: checks([]), bad: ["extensions.merge.checks"] },
  { name: "checks as a string", add: checks("repo-merge"), bad: ["extensions.merge.checks"] },
  {
    name: "an upper-case skill name",
    add: checks(["Repo-Merge"]),
    bad: ["extensions.merge.checks[0]"],
  },
  {
    name: "a skill name with a leading -",
    add: checks(["-x"]),
    bad: ["extensions.merge.checks[0]"],
  },
  { name: "an empty skill name", add: checks(["a", ""]), bad: ["extensions.merge.checks[1]"] },
  {
    name: "a namespaced skill name",
    add: checks(["repo:merge"]),
    bad: ["extensions.merge.checks[0]"],
  },
  {
    name: "a repeated skill name",
    add: checks(["a", "b", "a"]),
    bad: ["extensions.merge.checks[2]"],
  },
  {
    name: "a misspelled checks",
    add: { extensions: { merge: { check: ["a"] } } },
    bad: ["extensions.merge.check", "extensions.merge.checks"],
  },
  {
    name: "a misspelled merge",
    add: { extensions: { marge: { checks: ["a"] } } },
    bad: ["extensions.marge", "extensions.merge"],
  },
  // bad: conductor
  { name: "a conductor with no prompt", add: { conductor: {} }, bad: ["conductor.prompt"] },
  { name: "an empty prompt path", add: { conductor: { prompt: "" } }, bad: ["conductor.prompt"] },
  {
    name: "an absolute prompt path",
    add: { conductor: { prompt: "/home/x/CONDUCTOR.md" } },
    bad: ["conductor.prompt"],
  },
  {
    name: "a prompt path out",
    add: { conductor: { prompt: "../CONDUCTOR.md" } },
    bad: ["conductor.prompt"],
  },
  {
    name: "an empty rules heading",
    add: { conductor: { prompt: "C.md", rules: "" } },
    bad: ["conductor.rules"],
  },
  {
    name: "a rules heading as a list",
    add: { conductor: { prompt: "C.md", rules: ["Rules"] } },
    bad: ["conductor.rules"],
  },
  {
    name: "a misspelled prompt",
    add: { conductor: { promt: "C.md" } },
    bad: ["conductor.promt", "conductor.prompt"],
  },
  // bad: lifecycle writes
  {
    name: "a misspelled lifecycle write",
    add: life({ verdit: "status" }),
    bad: ["lifecycle.write.verdit"],
  },
  {
    name: "a handoff write that is no parent section",
    add: life({ handoff: "handoff" }),
    bad: ["lifecycle.write.handoff"],
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
  // bad
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
