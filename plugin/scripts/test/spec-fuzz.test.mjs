// Fuzz tests for the process file: a wrong-typed value at any key or list item, and a wrong, unknown
// or misspelled rule param, is a spec problem (exit 2 from the board, a note and fallback from
// find-contract), never a stack trace. The board exits 2 exactly when `loadSpec` reports a problem,
// so most cases are checked in process through `validateSpec`; a sample is run through the board.
// Run: node --test plugin/scripts/test/spec-fuzz.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "../lib/process/check.mjs";
import { readProcess } from "../lib/process/read.mjs";
import { CATALOG, FIELD } from "../lib/process/rules/index.mjs";
import { validateSpec } from "../lib/process/spec.mjs";
import { BASE, BUILTINS, ENTRIES, VALID, brokenBoard } from "./broken-boards.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..");
const BAD_VALUES = [null, "x", 7, [], true];

/** Every (path, bad value) up to `depth` keys or list items down the spec, as a mutated copy. */
function* mutations(node = VALID, path = [], depth = 6) {
  if (path.length === depth || node === null || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    const at = [...path, key];
    for (const bad of BAD_VALUES) {
      const copy = structuredClone(VALID);
      const parent = at.slice(0, -1).reduce((o, k) => o[k], copy);
      parent[key] = bad;
      yield { name: `${at.join(".")} = ${JSON.stringify(bad)}`, spec: copy };
    }
    yield* mutations(node[key], at, depth);
  }
}

// A file the check accepts must read and run every rule without a throw and without a rule that
// cannot run: that would be a param that slipped past the check.
function runsClean(spec, name) {
  const model = readProcess({ root: BASE, spec });
  const stuck = check(model, spec.rules, { hasCommit: () => true }).filter((f) =>
    f.message.startsWith("rule cannot run"),
  );
  assert.deepEqual(stuck, [], name);
}

test("a wrong-typed value at any key or list item is a spec problem, never a throw", () => {
  let n = 0;
  for (const { name, spec } of mutations()) {
    n++;
    let problems;
    assert.doesNotThrow(() => {
      problems = validateSpec(spec).problems;
    }, name);
    // other values are legitimate for some keys (a string, a flag, a list); null never is
    if (name.endsWith("= null")) assert.ok(problems.length > 0, `${name} should be reported`);
    if (problems.length === 0) assert.doesNotThrow(() => runsClean(spec, name), name);
  }
  assert.ok(n > 1000, `${n} mutations`);
});

const DEGENERATE = [
  { kinds: { task: null } },
  { kinds: { task: "x" } },
  { kinds: { task: [] } },
  { kinds: { task: 7 } },
  { kinds: { sprint: { fields: null } } },
  { kinds: { sprint: { fields: "x" } } },
  { kinds: { sprint: { fields: [] } } },
  { kinds: { sprint: { status: null } } },
  { kinds: { sprint: { status: { field: 7 } } } },
  { kinds: { sprint: { file: { sections: "x" } } } },
  { kinds: { sprint: { at: null } } },
  { kinds: { sprint: { id: "x" } } },
  { kinds: [] },
  { kinds: null },
  { kinds: "x" },
  { rules: null },
  { rules: [null] },
  { rules: "x" },
  { lifecycle: null },
  { drafts: [] },
];

function withSpec(patch) {
  const root = mkdtempSync(join(tmpdir(), "spec-fuzz-"));
  cpSync(BASE, root, { recursive: true });
  const spec = { ...structuredClone(VALID), ...patch };
  const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (plain(patch.kinds)) {
    spec.kinds = { ...VALID.kinds };
    for (const [k, v] of Object.entries(patch.kinds))
      spec.kinds[k] = plain(v) ? { ...VALID.kinds[k], ...v } : v;
  }
  writeFileSync(join(root, "process.json"), JSON.stringify(spec));
  return root;
}
const spawn = (script, args) =>
  spawnSync("node", [join(SCRIPTS, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

for (const patch of DEGENERATE) {
  test(`degenerate process file ${JSON.stringify(patch)} is reported, not crashed on`, () => {
    const root = withSpec(patch);
    try {
      const flags = ["--root", root, "--process", join(root, "process.json")];
      for (const sub of ["check", "status", "explain"]) {
        const out = spawn("board.mjs", [sub, ...flags]);
        assert.equal(out.status, 2, `${sub}: ${out.stderr}`);
        assert.match(out.stderr, /^✗ .*cannot use the process file/, sub);
        assert.doesNotMatch(out.stderr, /\n\s+at /, sub);
      }
      const found = spawn("find-contract.mjs", ["A1", ...flags]);
      assert.ok(found.status === 0 || found.status === 1, found.stderr);
      assert.match(found.stderr, /not used \(/);
      assert.doesNotMatch(found.stderr, /\n\s+at /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// A misspelling of a param name: its last letter turned into a "z" (`field` → `fielz`).
const typo = (name) => `${name.slice(0, -1)}${name.endsWith("z") ? "y" : "z"}`;

// `board check` on a copy of a fixture with these rules (and, given, this whole spec).
function checkWith(fixture, rules, whole) {
  const root = mkdtempSync(join(tmpdir(), "spec-fuzz-"));
  cpSync(join(HERE, "fixtures", fixture), root, { recursive: true });
  const spec = whole ?? JSON.parse(readFileSync(join(root, "process.json"), "utf8"));
  writeFileSync(join(root, "process.json"), JSON.stringify({ ...spec, rules }));
  try {
    return spawn("board.mjs", ["check", "--root", root, "--process", join(root, "process.json")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("every catalog rule has a valid entry here", () => {
  assert.deepEqual(Object.keys(ENTRIES).sort(), Object.keys(CATALOG).sort());
});

for (const [id, entry] of Object.entries(ENTRIES)) {
  test(`${id}: a misspelled param is a process-file error naming it, not a run without it`, () => {
    const valid = checkWith("table-board", [{ rule: id, ...entry }]);
    assert.ok(valid.status === 0 || valid.status === 1, `${id} as written: ${valid.stderr}`);
    const names = Object.keys(CATALOG[id].params);
    const typos = Object.fromEntries(
      (names.length ? names : ["kind"]).map((p) => [typo(p), entry[p] ?? "task"]),
    );
    const out = checkWith("table-board", [{ rule: id, ...entry, ...typos }]);
    assert.equal(out.status, 2, `${id}: ${out.stdout}`);
    for (const key of Object.keys(typos))
      assert.match(out.stderr, new RegExp(`rules\\[0\\]\\.${key} is not a param of ${id}`), key);
  });
}

test("a broken board with a wrong-typed or unknown rule param is exit 2, never OK", () => {
  const cases = [
    [{ rule: "deps-done", kind: "task", field: 7 }, /rules\[0\]\.field should be a string/],
    [{ rule: "deps-done", kind: "task", field: "depz" }, /rules\[0\]\.field names no task field/],
    [{ rule: "deps-done", kind: "task", feild: "deps" }, /rules\[0\]\.feild is not a param/],
    [{ rule: "parked", kind: "task", parking: "LATER", skip: "PRE" }, /rules\[0\]\.skip is not/],
    [{ rule: "deps-done", kind: "question" }, /rules\[0\] is missing "field", and no question/],
    [{ rule: "parked", kind: "task", parking: "LATR" }, /rules\[0\]\.parking names "LATR"/],
  ];
  for (const [rule, expected] of cases) {
    const out = checkWith("evidence-board", [rule]);
    assert.equal(out.status, 2, JSON.stringify(rule));
    assert.match(out.stderr, expected);
    assert.doesNotMatch(out.stderr + out.stdout, /OK|\n\s+at /);
  }
  const fine = checkWith("evidence-board", [{ rule: "deps-done", kind: "task", field: "deps" }]);
  assert.equal(fine.status, 1, "the board is broken under the rule as written");
});

test("a list or enum param given the wrong type is exit 2 on the board that uses it", () => {
  const verdict = {
    rule: "flagged-needs-verdict",
    kind: "task",
    flag: "risky",
    verdict: "verdict",
  };
  const cases = [
    [{ ...verdict, pass: "PASS" }, /rules\[0\]\.pass should be a list/],
    [{ rule: "sequential", kind: "sprint", skip: "PRE" }, /rules\[0\]\.skip should be a list/],
    [
      { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "all" },
      /rules\[0\]\.commit should be one of/,
    ],
  ];
  for (const [rule, expected] of cases) {
    const out = checkWith("table-board", [rule]);
    assert.equal(out.status, 2, JSON.stringify(rule));
    assert.match(out.stderr, expected);
    assert.doesNotMatch(out.stderr, /\n\s+at /);
  }
});

// Values of the wrong type, or naming nothing the file declares, for each declared param type.
const WRONG = {
  string: [7, [], true, null, {}],
  strings: ["x", 7, [7], null, {}],
  enum: ["nope", 7, null, []],
  kind: [7, "nope", null, ...BUILTINS],
  field: [7, "nope", null, ...BUILTINS],
  section: [7, "nope", null, ...BUILTINS],
  parent: [7, null, [], {}],
  except: ["x", [], { nope: ["a"] }, { id: "x" }, ...BUILTINS.map((b) => ({ [b]: ["a"] }))],
};

/** Every wrong entry for one rule, from its declared params: each param mistyped or naming nothing,
 *  each param name misspelled, an unknown key, and the built-in names as rule id, kind and key. */
function* ruleMutations(id) {
  const entry = { rule: id, ...ENTRIES[id] };
  const params = CATALOG[id].params;
  for (const [p, def] of Object.entries(params))
    for (const bad of WRONG[def.type])
      yield { name: `${p} = ${JSON.stringify(bad)}`, entry: { ...entry, [p]: bad } };
  for (const p of Object.keys(params)) {
    const { [p]: value, ...rest } = entry;
    const typoed = { ...entry, [typo(p)]: value ?? "x" };
    yield { name: `${typo(p)} beside ${p}`, entry: typoed };
    if (value !== undefined)
      yield { name: `${typo(p)} for ${p}`, entry: { ...rest, [typo(p)]: value } };
  }
  yield { name: "bogus key", entry: { ...entry, bogus: 1 } };
  for (const b of BUILTINS) {
    yield { name: `rule ${b}`, entry: { ...entry, rule: b } };
    yield { name: `key ${b}`, entry: { ...entry, [b]: 1 } };
    if (Object.hasOwn(params, "kind")) yield { name: `kind ${b}`, entry: { ...entry, kind: b } };
  }
}

for (const id of Object.keys(ENTRIES)) {
  test(`${id}: every wrong, unknown or misspelled param is a spec problem naming the entry`, () => {
    let n = 0;
    for (const { name, entry } of ruleMutations(id)) {
      n++;
      const spec = { ...structuredClone(VALID), rules: [entry] };
      let problems;
      assert.doesNotThrow(() => {
        problems = validateSpec(spec).problems;
      }, name);
      const named = problems.filter((p) => p.message.startsWith("rules[0]"));
      assert.ok(named.length > 0, `${id} ${name}: ${JSON.stringify(problems)}`);
    }
    assert.ok(n >= 9, `${id}: ${n} mutations`);
  });
}

// Built-in names where the file names a kind, a field or a rule, run through the board.
const at = (path) => (s, b) => {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => o[k], s)[last] = b;
};
const NAMED = [
  ["rules[].rule", (s, b) => s.rules.push({ rule: b })],
  ["rules[].kind", (s, b) => s.rules.push({ rule: "parent-active", kind: b })],
  ["rules[].field", (s, b) => s.rules.push({ rule: "deps-done", kind: "task", field: b })],
  ["rules[].<param>", (s, b) => s.rules.push(JSON.parse(`{"rule":"ids-unique","${b}":1}`))],
  ["fields.ref", at("kinds.task.fields.deps.ref")],
  ["status.field", at("kinds.task.status.field")],
  ["lifecycle.kind", at("lifecycle.kind")],
  ["status.now", at("status.now")],
];

for (const [where, set] of NAMED) {
  test(`a built-in name as ${where} is exit 2 naming it, never a stack trace`, () => {
    for (const b of BUILTINS) {
      const spec = structuredClone(VALID);
      set(spec, b);
      const out = checkWith("table-board", spec.rules, spec);
      assert.equal(out.status, 2, `${where} = ${b}: ${out.stdout}${out.stderr}`);
      assert.match(out.stderr, /cannot use the process file\n {2}\S/, `${where} = ${b}`);
      assert.doesNotMatch(out.stdout + out.stderr, /\n\s+at |TypeError|\[Function/, b);
    }
  });
}

// `board check` on a table-board copy broken for rule `id`, with these rules and kinds.
function checkBroken(id, rules, kinds = VALID.kinds) {
  const root = brokenBoard(id);
  try {
    writeFileSync(join(root, "process.json"), JSON.stringify({ ...VALID, kinds, rules }));
    return spawn("board.mjs", ["check", "--root", root, "--process", join(root, "process.json")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const fieldParams = Object.entries(CATALOG).flatMap(([id, rule]) =>
  Object.entries(rule.params)
    .filter(([, def]) => def.type === "field")
    .map(([p, def]) => [id, p, def]),
);

for (const [id, p, def] of fieldParams) {
  test(`${id}.${p}: every field of the wrong type is exit 2 on a board where the rule fires`, () => {
    const entry = { rule: id, ...ENTRIES[id] };
    const fired = checkBroken(id, [entry]);
    assert.equal(fired.status, 1, `${id} as written fires: ${fired.stdout}${fired.stderr}`);
    const fields = VALID.kinds[entry.kind].fields;
    const wrong = Object.keys(fields).filter((f) => !FIELD[def.is].fits(fields[f], entry.kind));
    assert.ok(wrong.length > 0, `${id}.${p}: the kind has a field of another type`);
    for (const f of wrong) {
      const out = checkBroken(id, [{ ...entry, [p]: f }]);
      assert.equal(out.status, 2, `${id}.${p} = "${f}": ${out.stdout}`);
      assert.match(out.stderr, new RegExp(`\\n {2}rules\\[0\\]\\.${p} names the `), f);
    }
    // The field it names as written, stripped of its `ref`: a list that points nowhere.
    const named = entry[p] ?? def.default;
    if (named && ["deps", "refs"].includes(def.is)) {
      const kinds = structuredClone(VALID.kinds);
      Reflect.deleteProperty(kinds[entry.kind].fields[named], "ref");
      const out = checkBroken(id, [entry], kinds);
      assert.equal(out.status, 2, `${id}.${p} = "${named}" without a ref: ${out.stdout}`);
      assert.match(out.stderr, new RegExp(`rules\\[0\\]\\.${p} .*"${named}" with no ref`));
    }
  });
}
