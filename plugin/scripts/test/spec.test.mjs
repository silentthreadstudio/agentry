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
    [spec("extra", true), /^extra is not a known key/],
    [spec("kinds.task.fields.status.type", "lst"), /^kinds\.task\.fields\.status\.type should/],
    [spec("kinds.task.fields.status.column"), /^kinds\.task\.fields\.status is missing "column"/],
    [spec("kinds.task.at", { path: "x" }), /^kinds\.task\.at should be "table" or "files"/],
    [spec("kinds.task.at", { files: "*.md", id: "name" }), /^kinds\.task\.at\.id should be/],
    [spec("kinds.task.status.values.todo", "open"), /^kinds\.task\.status\.values\.todo should/],
    [spec("kinds.task.id.match", "("), /^kinds\.task\.id\.match should be a valid regular/],
    [spec("rules.1", { label: "R2" }), /^rules\[1\] is missing "rule"/],
    [spec("rules.0.kind", "epic"), /^rules\[0\]\.kind names an unknown kind "epic"/],
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

test("rules keep their own params (open shape)", () => {
  assert.deepEqual(messages(spec("rules.1", { rule: "deps-done", field: "deps" })), []);
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
