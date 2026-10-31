// Fuzz tests for the process file: a wrong-typed value at any key is a spec problem (exit 2 from
// the board, a note and fallback from find-contract), never a stack trace.
// Run: node --test plugin/scripts/test/spec-fuzz.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../lib/process/rules/index.mjs";
import { validateSpec } from "../lib/process/spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..");
const BASE = join(HERE, "fixtures", "table-board");
const VALID = JSON.parse(readFileSync(join(BASE, "process.json"), "utf8"));
const BAD_VALUES = [null, "x", 7, [], true];

/** Every (path, bad value) up to `depth` keys down the object, as a mutated copy of the spec. */
function* mutations(node = VALID, path = [], depth = 4) {
  if (path.length === depth || node === null || typeof node !== "object" || Array.isArray(node))
    return;
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

test("a wrong-typed value at any key is a spec problem, never a throw", () => {
  let n = 0;
  for (const { name, spec } of mutations()) {
    n++;
    let problems;
    assert.doesNotThrow(() => {
      problems = validateSpec(spec).problems;
    }, name);
    // other values are legitimate for some keys (a string, a flag, a list); null never is
    if (name.endsWith("= null")) assert.ok(problems.length > 0, `${name} should be reported`);
  }
  assert.ok(n > 100);
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

// One entry per catalog rule that is valid on table-board, so a typo is the only thing wrong.
const ENTRIES = {
  "ids-unique": {},
  "status-known": {},
  "refs-resolve": {},
  "file-required": { kind: "sprint" },
  "members-listed": { kind: "sprint", section: "members", member: "task" },
  "deps-done": { kind: "task", field: "deps" },
  "parent-active": { kind: "task" },
  sequential: { kind: "sprint", skip: ["PRE", "TRK", "LATER"] },
  "question-blocks": { kind: "question", field: "blocks" },
  parked: { kind: "task", parking: "LATER" },
  "deps-not-forward": { kind: "task", field: "deps", skip: ["LATER"] },
  "done-has-evidence": { kind: "task", field: "commit", evidence: "commit" },
  "done-has-handoff": { kind: "task", section: "handoff", commit: "first" },
  "flagged-needs-verdict": { kind: "task", flag: "risky", verdict: "verdict", pass: ["PASS"] },
  "closed-children": { kind: "sprint" },
  "done-signoff": { kind: "sprint", field: "ok" },
};
// A misspelling of a param name: its last letter turned into a "z" (`field` → `fielz`).
const typo = (name) => `${name.slice(0, -1)}${name.endsWith("z") ? "y" : "z"}`;

function checkWith(fixture, rules) {
  const root = mkdtempSync(join(tmpdir(), "spec-fuzz-"));
  cpSync(join(HERE, "fixtures", fixture), root, { recursive: true });
  const spec = JSON.parse(readFileSync(join(root, "process.json"), "utf8"));
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
