// Tests for lib/process/spec.mjs — hand validation of the process file (plan F13 §3.1).
// Run: node --test plugin/scripts/test/spec.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CAN, lacks } from "../lib/process/rules/index.mjs";
import { checkOnBoard, escapesRoot, parseSpec, validateSpec } from "../lib/process/spec.mjs";
import { SPEC, makeModel, sprint, task } from "./rules-model.mjs";

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
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", done: "done", later: "parked" },
      },
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
  const entry = { rule: "sequential", kind: "task", skip: ["X"], note: "why it is on" };
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
  copy.kinds.task.fields.sprint = { column: "Sprint", type: "ref", ref: "sprint", role: "parent" };
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
      /^rules\[1\]\.section names no bold-lead section "handof" of the sprint file/,
    ],
    [
      { rule: "done-has-handoff", kind: "sprint", section: "handoff" },
      /^rules\[1\]\.kind names "sprint", which lacks .* and a field with role "parent"; done-has-handoff needs it$/,
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
  const fine = { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "none" };
  assert.deepEqual(messages(withTree(fine)), []);
});

test("a field param left out defaults to the first field of its type, and none to pick is a problem", () => {
  const cases = [
    [
      { rule: "deps-done", kind: "task" },
      /^rules\[1\] is missing "field", and no task field fits \(deps-done needs a list field whose ref includes "task"\)$/,
    ],
    [{ rule: "parked", kind: "task", parking: "LATER" }, /^rules\[1\] is missing "field", and no/],
    [{ rule: "deps-not-forward", kind: "task" }, /^rules\[1\] is missing "field", and no/],
    [
      { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "first" },
      /^rules\[1\] is missing "field", and no task field fits \(done-has-handoff needs a commits or evidence field\)$/,
    ],
  ];
  for (const [rule, expected] of cases) {
    const found = messages(withTree(rule));
    assert.ok(
      found.some((m) => expected.test(m)),
      `${expected} not in ${JSON.stringify(found)}`,
    );
  }
  for (const rule of cases.map(([r]) => r)) assert.deepEqual(messages(typed(rule)), [], rule.rule);
});

test("except keys are checked against the kinds the rule checks, also when kind is left out", () => {
  const required = (rule) => {
    const copy = withTree(rule);
    copy.kinds.sprint.file.required = true;
    copy.kinds.sprint.fields = { status: { column: "Status" } };
    copy.kinds.task.file = { glob: "t/{id}.md" };
    return copy;
  };
  const cases = [
    [{ except: { sprnt: ["X"] } }, 'rules[1].except.sprnt names no sprint field (or "id")'],
    [{ except: { toString: ["X"] } }, 'rules[1].except.toString names no sprint field (or "id")'],
    [{ kind: "task", except: { status: ["X"] } }, null],
    [{ kind: "task", except: { sprint: ["X"] } }, null],
    [{ except: { sprint: ["X"] } }, 'rules[1].except.sprint names no sprint field (or "id")'],
    [{ except: { id: ["X"], status: ["X"] } }, null],
  ];
  for (const [params, expected] of cases) {
    const found = messages(required({ rule: "file-required", ...params }));
    assert.deepEqual(found, expected ? [expected] : [], JSON.stringify(params));
  }
});

test("a param used only with another's value is a problem given without it", () => {
  const entry = { rule: "done-has-handoff", kind: "task", section: "handoff", field: "commit" };
  assert.deepEqual(messages(typed(entry)), [
    'rules[1].field is used only when commit is "first" or "any"',
  ]);
  assert.deepEqual(messages(typed({ ...entry, commit: "any" })), []);
});

// withTree plus one field of every type the field params ask for, and a few they do not.
function typed(rule) {
  const copy = withTree(rule);
  Object.assign(copy.kinds.task.fields, {
    deps: { column: "Deps", type: "list", ref: "task" },
    blocks: { column: "Blocks", type: "list" },
    commit: { column: "Commit", type: "commits" },
    risky: { column: "Risky", type: "flag", mark: "!" },
    shipped: { column: "Shipped", type: "date" },
    note: { column: "Note" },
  });
  return copy;
}

test("a field param naming a field of the wrong type is a problem naming the param and the type", () => {
  const needs = (rule, want) => new RegExp(`; ${rule} needs ${want}$`);
  const deps = (rule) => needs(rule, 'a list field whose ref includes "task"');
  const cases = [
    [
      { rule: "deps-done", kind: "task", field: "commit" },
      /^rules\[1\]\.field names the commits field "commit"; deps-done needs a list field whose ref includes "task"$/,
    ],
    [
      { rule: "deps-done", kind: "task", field: "blocks" },
      /field names the list field "blocks" with no ref;/,
    ],
    [
      { rule: "deps-done", kind: "task", field: "sprint" },
      /field names the ref field "sprint" of sprint;/,
    ],
    [{ rule: "deps-not-forward", kind: "task", field: "note" }, deps("deps-not-forward")],
    [{ rule: "parked", kind: "task", parking: "LATER", field: "commit" }, deps("parked")],
    [
      { rule: "question-blocks", kind: "task", field: "note" },
      needs("question-blocks", "a list field with a ref"),
    ],
    [
      { rule: "question-blocks", kind: "task" },
      /^rules\[1\]\.field defaults to "blocks", which names the list field "blocks" with no ref; question-blocks needs a list field with a ref$/,
    ],
    [
      { rule: "done-has-evidence", kind: "task", field: "note", evidence: "commit-or-note" },
      needs("done-has-evidence", "a commits or evidence field"),
    ],
    [
      {
        rule: "done-has-handoff",
        kind: "task",
        section: "handoff",
        commit: "first",
        field: "note",
      },
      needs("done-has-handoff", "a commits or evidence field"),
    ],
    [
      { rule: "flagged-needs-verdict", kind: "task", flag: "note", verdict: "note", pass: ["OK"] },
      /^rules\[1\]\.flag names the text field "note"; flagged-needs-verdict needs a flag field$/,
    ],
    [
      {
        rule: "flagged-needs-verdict",
        kind: "task",
        flag: "risky",
        verdict: "risky",
        pass: ["OK"],
      },
      /^rules\[1\]\.verdict names the flag field "risky"; flagged-needs-verdict needs a text field$/,
    ],
    [{ rule: "done-signoff", kind: "task", field: "note" }, needs("done-signoff", "a date field")],
  ];
  for (const [rule, expected] of cases) {
    const found = messages(typed(rule));
    assert.ok(
      found.some((m) => expected.test(m)),
      `${expected} not in ${JSON.stringify(found)}`,
    );
  }
  const fine = [
    { rule: "deps-done", kind: "task", field: "deps" },
    { rule: "question-blocks", kind: "task", field: "deps" },
    { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" },
    { rule: "flagged-needs-verdict", kind: "task", flag: "risky", verdict: "note", pass: ["OK"] },
    { rule: "done-signoff", kind: "task", field: "shipped" },
  ];
  for (const rule of fine) assert.deepEqual(messages(typed(rule)), [], rule.rule);
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
  copy.rules.push({ rule: "sequential", kind: "constructor" });
  assert.deepEqual(messages(copy), []);
});

test("a path that leaves the repository is a spec problem; ../ inside it is fine", () => {
  assert.deepEqual(messages(spec("kinds.task.at.table", "../DECISIONS.md")), []);
  const outside = /kinds\.task\.at\.table "\.\.\/\.\.\/outside\.md" leaves the repository/;
  assert.ok(flags(spec("kinds.task.at.table", "../../outside.md"), outside));
  assert.ok(flags(spec("root", "../elsewhere"), /^root .* leaves/));
  assert.ok(flags(spec("root", "/abs"), /^root .* leaves/));
  assert.ok(flags(spec("kinds.task.file", { glob: "../../{id}.md" }), /file\.glob .* leaves/));
  assert.ok(flags(spec("status", { note: "../NOTE.md" }), /^status\.note .* leaves/));
});

test("escapesRoot normalises the path against the spec root", () => {
  assert.equal(escapesRoot("docs/board", "../DECISIONS.md"), false);
  assert.equal(escapesRoot("docs/board", "../../x.md"), false);
  assert.equal(escapesRoot("docs/board", "../../../x.md"), true);
  assert.equal(escapesRoot(".", "a/../../x.md"), true);
  assert.equal(escapesRoot(".", "/etc/passwd"), true);
});

test("parked's parking value is a parent the kind can hold: an item on the board or an also value", () => {
  const entry = (parking) => ({ rule: "parked", kind: "task", parking });
  const board = (parking) => {
    const spec = { ...structuredClone(SPEC), rules: [entry(parking)] };
    const items = [sprint("S1", "doing"), sprint("LATER", "todo"), task("T1", "S1", "todo")];
    return checkOnBoard(spec, makeModel(items, spec)).map((p) => p.message);
  };
  assert.deepEqual(board("LATER"), []);
  assert.deepEqual(board("EXTRA"), [], "an also value of the parent field");
  assert.deepEqual(board("LATR"), [
    'rules[0].parking names "LATR", neither a sprint on the board nor an "also" value of task.sprint',
  ]);
  assert.equal(board("T1").length, 1, "a task is no sprint");
  const lost = { ...structuredClone(SPEC), rules: [entry("LATR")] };
  const model = makeModel([task("T1", "S1", "todo")], lost);
  model.kinds.sprint.located = false;
  assert.deepEqual(checkOnBoard(lost, model), [], "a parent kind not found is not judged");
  const orphan = messages(withTree({ rule: "parked", kind: "sprint", parking: "LATER" }));
  assert.ok(
    orphan.includes(
      'rules[1].kind names "sprint", which lacks a status that can be "parked" and a field with role "parent"; parked needs it',
    ),
  );
});

// The reader's invariants (spec.mjs header): each edit of withTree breaks one, refused naming its key.
const tree = (edit, rule = { rule: "ids-unique" }) => {
  const copy = withTree(rule);
  edit(copy);
  return messages(copy);
};
const DERIVED_ALONE =
  'kinds.sprint.status.derived needs children with a status (a kind whose parent field refs sprint, or a children list of sprint, to a kind with a status); without, every sprint is "planned"';
const READER = [
  [
    "a parent field read as a list links no parent",
    (s) => {
      s.kinds.task.fields.sprint.type = "list";
    },
    ['kinds.task.fields.sprint has role "parent", which needs type "ref", not "list"'],
  ],
  [
    "a parent field read as text links by a ref it does not read",
    (s) => {
      Reflect.deleteProperty(s.kinds.task.fields.sprint, "type");
    },
    [
      'kinds.task.fields.sprint.ref is read only from a "ref" or "list" field, and "sprint" is text',
      'kinds.task.fields.sprint has role "parent", which needs type "ref", not "text"',
    ],
  ],
  [
    "a children field read as one id links no children",
    (s) => {
      Reflect.deleteProperty(s.kinds.task.fields.sprint, "role");
      s.kinds.sprint.fields = {
        tasks: { column: "Tasks", type: "ref", ref: "task", role: "children" },
      };
    },
    ['kinds.sprint.fields.tasks has role "children", which needs type "list", not "ref"'],
  ],
  [
    "a second parent field (the reader keeps the last, the rules the first)",
    (s) => {
      s.kinds.task.fields.epic = { column: "Epic", type: "ref", ref: "sprint", role: "parent" };
    },
    ['kinds.task.fields.epic.role is "parent" as "sprint" is; a kind has one parent field'],
  ],
  [
    "a ref list naming no kind",
    (s) => {
      s.kinds.task.fields.sprint.ref = [];
    },
    ["kinds.task.fields.sprint.ref should name at least one kind"],
  ],
  [
    "a ref on a field whose value is no id",
    (s) => {
      s.kinds.task.fields.risky = { column: "Risk", type: "flag", ref: "task" };
    },
    ['kinds.task.fields.risky.ref is read only from a "ref" or "list" field, and "risky" is flag'],
  ],
  [
    "an upper-cased ref, which would no longer name a mixed-case id",
    (s) => {
      s.kinds.task.fields.sprint.case = "upper";
    },
    ['kinds.task.fields.sprint.case is read only on a text field, and "sprint" is ref'],
  ],
  [
    "a status read from a list field",
    (s) => {
      s.kinds.task.fields.status.type = "list";
    },
    [
      'kinds.task.status.field names the list field "status"; a status is one word, read from a text field',
    ],
  ],
  [
    "a status read upper case against a lower-case word",
    (s) => {
      s.kinds.task.fields.status.case = "upper";
      s.kinds.task.status.values = { TODO: "planned", doing: "active" };
    },
    ['kinds.task.status.values.doing can never match: "status" reads upper case ("case": "upper")'],
  ],
  [
    "a derived status with no child kind",
    (s) => {
      s.kinds.sprint.status = { derived: "children" };
      Reflect.deleteProperty(s.kinds.task.fields.sprint, "role");
    },
    [DERIVED_ALONE],
  ],
  [
    "a derived status whose child kind has none",
    (s) => {
      s.kinds.sprint.status = { derived: "children" };
      Reflect.deleteProperty(s.kinds.task, "status");
    },
    [DERIVED_ALONE],
  ],
];

for (const [name, edit, expected] of READER)
  test(`the reader's invariants: ${name} is refused naming the key`, () => {
    assert.deepEqual(tree(edit), expected);
  });

test("the reader's invariants hold on what the reader can use", () => {
  const fine = [
    (s) => {
      s.kinds.sprint.status = { derived: "children" };
    },
    (s) => {
      s.kinds.task.fields.status.case = "upper";
      s.kinds.task.status.values = { TODO: "planned", DOING: "active" };
    },
    (s) => {
      s.kinds.sprint.fields = {
        tasks: { column: "Tasks", type: "list", ref: "task", role: "children" },
      };
    },
  ];
  for (const edit of fine) assert.deepEqual(tree(edit), []);
});

test("a section a rule reads by its bold leads must be a bold-lead section", () => {
  const handoff = { rule: "done-has-handoff", kind: "task", section: "tasks" };
  const found = tree((s) => {
    s.kinds.sprint.file.sections.tasks = { heading: "Tasks", as: "table", column: "Task" };
  }, handoff);
  assert.deepEqual(found, [
    'rules[1].section names no bold-lead section "tasks" of the sprint file',
  ]);
});

test("a capability counts a role field only of the type the reader links it by", () => {
  const { kinds } = withTree({ rule: "ids-unique" });
  assert.deepEqual(lacks(kinds, "task", ["parent", "order"]), []);
  kinds.task.fields.sprint.type = "list";
  const lacking = ["parent", "order"].map((c) => CAN[c].says());
  assert.deepEqual(lacks(kinds, "task", ["parent", "order"]), lacking);
  assert.deepEqual(lacks(kinds, "sprint", ["children"]), [CAN.children.says()]);
  assert.deepEqual(lacks(kinds, "task", ["child"], "sprint"), [CAN.child.says("sprint")]);
  Reflect.deleteProperty(kinds.task.fields.sprint, "role");
  kinds.sprint.fields = { tasks: { column: "Tasks", type: "ref", ref: "task", role: "children" } };
  assert.deepEqual(lacks(kinds, "sprint", ["children"]), [CAN.children.says()]);
  kinds.sprint.fields.tasks.type = "list";
  assert.deepEqual(lacks(kinds, "sprint", ["children"]), []);
});

test("a derived status can be done or started only with children that have a status", () => {
  const { kinds } = withTree({ rule: "ids-unique" });
  kinds.sprint.status = { derived: "children" };
  const both = ["done", "started"];
  assert.deepEqual(lacks(kinds, "sprint", both), []);
  kinds.task.status.values = { todo: "planned" };
  assert.deepEqual(
    lacks(kinds, "sprint", both),
    both.map((c) => CAN[c].says()),
  );
  Reflect.deleteProperty(kinds.task, "status");
  assert.deepEqual(
    lacks(kinds, "sprint", both),
    both.map((c) => CAN[c].says()),
  );
});

// Cells are read trimmed, without `**` or backticks (markdown.mjs `plain`): a status word written
// otherwise is one no cell can ever hold.
for (const word of ["done ", " done", "**done**", "`done`", "do`ne"])
  test(`a status word the reader can never produce is refused: ${JSON.stringify(word)}`, () => {
    const s = spec("kinds.task.status.values", { todo: "planned", [word]: "done" });
    const found = messages(s);
    assert.equal(found.length, 1, found.join(" | "));
    assert.ok(
      found[0].startsWith(`kinds.task.status.values.${word} can never match: the reader trims`),
      found[0],
    );
    assert.match(found[0], /strips "\*\*" and backticks/);
  });

test("param-less rules with nothing to check are refused, like file-required", () => {
  const noStatus = spec("rules.1", { rule: "status-known" });
  Reflect.deleteProperty(noStatus.kinds.task, "status");
  assert.deepEqual(messages(noStatus), [
    "rules[1] no kind has status values: status-known would check nothing",
  ]);
  assert.deepEqual(messages(spec("rules.1", { rule: "status-known" })), []);
  assert.deepEqual(messages(spec("rules.1", { rule: "refs-resolve" })), [
    "rules[1] no field has a ref: refs-resolve would check nothing",
  ]);
  assert.deepEqual(messages(withTree({ rule: "refs-resolve" })), [], "task.sprint refs sprint");
});

test("a table kind names its id column; a table section names its column", () => {
  const noId = spec("kinds.task.id");
  assert.deepEqual(messages(noId), ['kinds.task.id needs a "column"']);
  const noColumn = withTree({ rule: "ids-unique" });
  noColumn.kinds.sprint.file.sections.tasks = { heading: "Tasks", as: "table" };
  assert.deepEqual(messages(noColumn), ['kinds.sprint.file.sections.tasks needs a "column"']);
});

test("a files kind's filename pattern must hold {id}", () => {
  const files = (id) => {
    const s = spec("kinds.task.at", { files: "tasks/*.md", id });
    Reflect.deleteProperty(s.kinds.task, "id");
    return messages(s);
  };
  assert.deepEqual(files("filename:{id}.md"), []);
  assert.equal(files("filename:task.md").length, 1);
  assert.deepEqual(files("frontmatter:id"), []);
});
