// Tests for lib/process/spec.mjs — hand validation of the process file (plan F13 §3.1).
// Run: node --test plugin/scripts/test/spec.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { escapesRoot, parseSpec, validateSpec } from "../lib/process/spec.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => readFileSync(join(FIXTURES, name, "process.json"), "utf8");

const MINI = {
  version: 1,
  name: "Mini",
  root: "docs",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", done: "done" } },
    },
  },
  rules: [{ rule: "ids-unique" }],
};

/** A copy of MINI with one dotted path set, or deleted when no value is given. */
function spec(path, ...value) {
  const copy = structuredClone(MINI);
  if (!path) return copy;
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o[k], copy);
  if (value.length) parent[last] = value[0];
  else Reflect.deleteProperty(parent, last);
  return copy;
}
const messages = (value) => validateSpec(value).problems.map((p) => p.message);
const flags = (value, re) => messages(value).some((m) => re.test(m));

test("the synthetic fixtures' process files are valid", () => {
  for (const name of ["table-board", "evidence-board", "frontmatter-board"]) {
    const { spec: parsed, problems } = parseSpec(fixture(name), { file: `${name}/process.json` });
    assert.deepEqual(problems, [], name);
    assert.equal(parsed.version, 1);
  }
});

test("a minimal spec is valid", () => {
  assert.deepEqual(messages(spec()), []);
});

test("invalid JSON is a problem with the file, not a throw", () => {
  const { spec: parsed, problems } = parseSpec("{ nope", { file: "p.json" });
  assert.equal(parsed, null);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "spec");
  assert.equal(problems[0].file, "p.json");
  assert.match(problems[0].message, /not valid JSON/);
});

test("each problem names its path in the file", () => {
  const cases = [
    [spec("version", 2), /^version should be one of "1"/],
    [spec("kinds"), /^the process file is missing "kinds"/],
    [spec("kinds", {}), /^kinds should name at least one kind/],
    [spec("extra", true), /^extra is not a known key/],
    [spec("kinds.task.fields.status.type", "lst"), /^kinds\.task\.fields\.status\.type should/],
    [spec("kinds.task.fields.status.column"), /^kinds\.task\.fields\.status is missing "column"/],
    [spec("kinds.task.at", { path: "x" }), /^kinds\.task\.at should be "table" or "files"/],
    [spec("kinds.task.at", { files: "*.md", id: "name" }), /^kinds\.task\.at\.id should be/],
    [spec("kinds.task.status.values.todo", "open"), /^kinds\.task\.status\.values\.todo should/],
    [spec("kinds.task.id.match", "("), /^kinds\.task\.id\.match should be a valid regular/],
    [spec("rules.1", { label: "R2" }), /^rules\[1\] is missing "rule"/],
    [
      spec("rules.1", { rule: "parent-active", kind: "epic" }),
      /^rules\[1\]\.kind names an unknown kind "epic"/,
    ],
    [spec("kinds.task.status.field", "state"), /^kinds\.task\.status\.field names no field/],
    [spec("kinds.task.file", { glob: "sprints/*.md" }), /^kinds\.task\.file\.glob should be a/],
    [
      spec("kinds.task.fields.deps", { column: "Deps", type: "list", ref: ["task", "epic"] }),
      /^kinds\.task\.fields\.deps\.ref names an unknown kind "epic"/,
    ],
    [
      spec("kinds.task.fields.sprint", { column: "Sprint", role: "parent" }),
      /^kinds\.task\.fields\.sprint has role "parent" but no "ref"/,
    ],
  ];
  for (const [value, expected] of cases) {
    assert.ok(flags(value, expected), `${expected} not in ${JSON.stringify(messages(value))}`);
  }
});

test("a rule entry takes the params its rule declares, and a note", () => {
  const entry = { rule: "deps-done", kind: "task", field: "status", note: "why it is on" };
  assert.deepEqual(messages(spec("rules.1", entry)), []);
});

// MINI plus what the rule params can name: a sprint with an own file, a task with a parent.
function withTree(rule) {
  const copy = spec("rules.1", rule);
  copy.kinds.sprint = {
    label: "Sprint",
    at: { table: "BOARD.md", heading: "Sprints" },
    id: { column: "Sprint" },
    file: { glob: "s/{id}.md", sections: { handoff: { heading: "Handoff", as: "bold-lead" } } },
  };
  copy.kinds.task.fields.sprint = { column: "Sprint", ref: "sprint", role: "parent" };
  return copy;
}

test("a rule entry with a param its rule does not declare, or lacks, or mistypes, is a problem", () => {
  const cases = [
    [{ rule: "nope" }, /^rules\[1\]\.rule names an unknown rule "nope" \("ids-unique"/],
    [{ rule: "toString" }, /^rules\[1\]\.rule names an unknown rule "toString"/],
    [{ rule: "ids-unique", kind: "task" }, /^rules\[1\]\.kind is not a param of ids-unique/],
    [
      { rule: "deps-done", kind: "task", feild: "status" },
      /^rules\[1\]\.feild is not a param of deps-done \(its params: "kind", "field", "except"\)/,
    ],
    [{ rule: "deps-done", field: "status" }, /^rules\[1\] is missing "kind"/],
    [{ rule: "deps-done", kind: "task", field: 7 }, /^rules\[1\]\.field should be a string/],
    [
      { rule: "deps-done", kind: "task", field: "depz" },
      /^rules\[1\]\.field names no task field "depz"/,
    ],
    [
      { rule: "deps-done", kind: "task", field: "constructor" },
      /^rules\[1\]\.field names no task field "constructor"/,
    ],
    [{ rule: "sequential", kind: "task", skip: "PRE" }, /^rules\[1\]\.skip should be a list/],
    [
      {
        rule: "flagged-needs-verdict",
        kind: "task",
        flag: "status",
        verdict: "status",
        pass: "OK",
      },
      /^rules\[1\]\.pass should be a list/,
    ],
    [
      { rule: "done-has-evidence", kind: "task", field: "status", evidence: "sha" },
      /^rules\[1\]\.evidence should be one of "commit", "commit-or-note"/,
    ],
    [
      { rule: "question-blocks", kind: "task" },
      /^rules\[1\]\.field defaults to "blocks", which names no task field "blocks"/,
    ],
    [
      { rule: "parked", kind: "task", parking: "LATER", except: { sprnt: ["X"] } },
      /^rules\[1\]\.except\.sprnt names no task field \(or "id"\)/,
    ],
    [
      { rule: "parked", kind: "task", parking: "LATER", except: { id: "X" } },
      /^rules\[1\]\.except\.id should be a list/,
    ],
    [
      { rule: "members-listed", kind: "task", section: "tasks", member: "task" },
      /^rules\[1\]\.section names no section "tasks" of the task file/,
    ],
    [
      { rule: "done-has-handoff", kind: "task", section: "handof" },
      /^rules\[1\]\.section names no section "handof" of the sprint file/,
    ],
    [
      { rule: "done-has-handoff", kind: "sprint", section: "handoff" },
      /^rules\[1\]\.section needs a parent, and sprint has no field with role "parent"/,
    ],
    [
      { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "all" },
      /^rules\[1\]\.commit should be one of "first", "any", "none"/,
    ],
  ];
  for (const [rule, expected] of cases) {
    const found = messages(withTree(rule));
    assert.ok(
      found.some((m) => expected.test(m)),
      `${expected} not in ${JSON.stringify(found)}`,
    );
  }
  const fine = { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "any" };
  assert.deepEqual(messages(withTree(fine)), []);
});

test("a name from the file never reads a built-in: kinds, fields, rules, lifecycle", () => {
  const cases = [
    [
      spec("rules.1", { rule: "parent-active", kind: "toString" }),
      /^rules\[1\]\.kind names an unknown kind "toString"/,
    ],
    [spec("lifecycle", { kind: "hasOwnProperty", on: {} }), /^lifecycle\.kind names an unknown/],
    [spec("status", { now: "constructor" }), /^status\.now names an unknown kind "constructor"/],
    [spec("kinds.task.status.field", "toString"), /^kinds\.task\.status\.field names no field/],
    [spec("kinds.task.toString", "x"), /^kinds\.task\.toString is not a known key/],
    [spec("kinds.task.fields.status.ref", "constructor"), /\.ref names an unknown kind/],
    [JSON.parse('{"version":1,"__proto__":{}}'), /^__proto__ is not a known key/],
    [spec("kinds", JSON.parse('{"__proto__":{}}')), /^kinds\.__proto__ is a reserved name/],
  ];
  for (const [value, expected] of cases) {
    assert.ok(flags(value, expected), `${expected} not in ${JSON.stringify(messages(value))}`);
  }
});

test("a kind may be named like a built-in when the file declares it", () => {
  const copy = spec();
  copy.kinds.constructor = structuredClone(MINI.kinds.task);
  copy.rules.push({ rule: "parent-active", kind: "constructor" });
  assert.deepEqual(messages(copy), []);
});

test("a path that leaves the repository is a spec problem; ../ inside it is fine", () => {
  assert.deepEqual(messages(spec("kinds.task.at.table", "../DECISIONS.md")), []);
  const outside = /kinds\.task\.at\.table "\.\.\/\.\.\/outside\.md" leaves the repository/;
  assert.ok(flags(spec("kinds.task.at.table", "../../outside.md"), outside));
  assert.ok(flags(spec("root", "../elsewhere"), /^root .* leaves/));
  assert.ok(flags(spec("root", "/abs"), /^root .* leaves/));
  assert.ok(flags(spec("kinds.task.file", { glob: "../../{id}.md" }), /file\.glob .* leaves/));
});

test("escapesRoot normalises the path against the spec root", () => {
  assert.equal(escapesRoot("docs/board", "../DECISIONS.md"), false);
  assert.equal(escapesRoot("docs/board", "../../x.md"), false);
  assert.equal(escapesRoot("docs/board", "../../../x.md"), true);
  assert.equal(escapesRoot(".", "a/../../x.md"), true);
  assert.equal(escapesRoot(".", "/etc/passwd"), true);
});
