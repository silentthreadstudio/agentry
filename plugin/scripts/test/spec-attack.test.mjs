// Attack tests for the rule params: for every catalog rule, a board where it fires (broken-boards.mjs),
// and on it every wrong value of every param (another kind, a field of another type, a misspelling, a
// built-in name, a wrongly typed value) is a refused process file naming the param, never OK; a skip
// or except value that names nothing is a finding of its own. Every kind carries decoy fields of every
// type, so a field param always has a wrong field to be given. Judged in process the way `board check`
// judges (`outcome`); a sample goes through the board itself.
// Run: node --test plugin/scripts/test/spec-attack.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATALOG, FIELD } from "../lib/process/rules/index.mjs";
import { BREAK, BUILTINS, ENTRIES, VALID, brokenBoard, outcome } from "./broken-boards.mjs";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");
const KINDS = Object.keys(VALID.kinds);

// One field of every type on every kind, each reading a column the kind's table has.
const COLUMN = {
  milestone: "Sprints",
  sprint: "Name",
  task: "Deps",
  question: "Blocks",
  decision: "Why",
};
function decoyed() {
  const spec = structuredClone(VALID);
  for (const [k, column] of Object.entries(COLUMN)) {
    const other = KINDS.find((x) => x !== k);
    Object.assign(spec.kinds[k].fields, {
      z_text: { column },
      z_list: { column, type: "list" },
      z_list_other: { column, type: "list", ref: other },
      z_list_self: { column, type: "list", ref: k },
      z_ref_self: { column, type: "ref", ref: k },
      z_link: { column, type: "link" },
      z_flag: { column, type: "flag", mark: "⚑" },
      z_date: { column, type: "date" },
      z_commits: { column, type: "commits" },
      z_evidence: { column, type: "evidence" },
    });
  }
  return spec;
}
const DECOYED = decoyed();

// The kinds besides its own that a rule as ENTRIES writes it can check: the swap still fires.
const ACCEPTS = { sequential: ["milestone", "task", "question"] };

const roots = {};
before(() => {
  for (const id of Object.keys(CATALOG)) roots[id] = brokenBoard(id);
});
after(() => {
  for (const root of Object.values(roots)) rmSync(root, { recursive: true, force: true });
});
const judge = (id, entry, spec = DECOYED) => outcome({ ...spec, rules: [entry] }, roots[id]);
const show = (r) => `exit ${r.exit}: ${r.messages.slice(0, 3).join(" | ")}`;
const typo = (name) => `${name.slice(0, -1)}${name.endsWith("z") ? "y" : "z"}`;
// `{ key: value }` as an own property, also for `__proto__`.
const own = (key, value) => JSON.parse(`{${JSON.stringify(key)}: ${JSON.stringify(value)}}`);

test("every catalog rule has a board here where it fires as written", () => {
  assert.deepEqual(Object.keys(BREAK).sort(), Object.keys(CATALOG).sort());
  assert.deepEqual(Object.keys(ENTRIES).sort(), Object.keys(CATALOG).sort());
  for (const id of Object.keys(CATALOG)) {
    for (const spec of [VALID, DECOYED]) {
      const r = judge(id, { rule: id, ...ENTRIES[id] }, spec);
      assert.equal(r.exit, 1, `${id}: ${show(r)}`);
      assert.ok(
        r.messages.some((m) => m.startsWith(`${id}: `) && !m.includes("rules[0]")),
        `${id} fires: ${show(r)}`,
      );
      assert.ok(!r.messages.some((m) => /rule cannot run|names no item/.test(m)), show(r));
    }
  }
});

/** Every wrong entry for one rule: [name, entry, the path the refusal must name]. */
function* wrongEntries(id) {
  const entry = { rule: id, ...ENTRIES[id] };
  const params = CATALOG[id].params;
  const kind = DECOYED.kinds[entry.kind];
  for (const [p, def] of Object.entries(params)) {
    const at = `rules[0].${p}`;
    const bad = (value) => [`${p} = ${JSON.stringify(value)}`, { ...entry, [p]: value }];
    const plain = [7, null, [], {}, true];
    if (def.type === "kind") {
      // Another kind may be refused through a param that depends on it (a field it lacks).
      const swaps = KINDS.filter(
        (k) => k !== entry[p] && !(p === "kind" && ACCEPTS[id]?.includes(k)),
      );
      for (const v of swaps) yield [...bad(v), "rules[0]"];
      for (const v of ["nope", ...BUILTINS, ...plain]) yield [...bad(v), at];
    }
    if (def.type === "field") {
      const fields = kind.fields;
      const misfit = Object.keys(fields).filter((f) => !FIELD[def.is].fits(fields[f], entry.kind));
      const elsewhere = KINDS.flatMap((k) => Object.keys(DECOYED.kinds[k].fields)).filter(
        (f) => !Object.hasOwn(fields, f),
      );
      const only = def.only ? { commit: "first" } : {};
      for (const v of [...misfit, ...new Set(elsewhere), "nope", ...BUILTINS, ...plain])
        yield [`${p} = ${JSON.stringify(v)}`, { ...entry, ...only, [p]: v }, at];
    }
    if (def.type === "section")
      for (const v of ["nope", "Tasks", "Handoff", ...BUILTINS, ...plain]) yield [...bad(v), at];
    if (def.type === "enum") {
      const others = Object.values(CATALOG)
        .flatMap((r) => Object.values(r.params))
        .flatMap((d) => (d.type === "enum" ? d.values : []))
        .filter((v) => !def.values.includes(v));
      for (const v of [...new Set(others), "bogus", ...BUILTINS, ...plain]) yield [...bad(v), at];
    }
    if (def.type === "strings") for (const v of ["PRE", 7, [7], null, {}]) yield [...bad(v), at];
    if (def.type === "parent")
      for (const v of ["LATR", "W1", "Q-01", "M1", ...BUILTINS, ...plain]) yield [...bad(v), at];
    if (def.type === "except") {
      for (const v of [["x"], "x", 7, null, { id: "W1" }, { nope: ["W1"] }]) yield [...bad(v), at];
      for (const b of BUILTINS) yield [`${p} key ${b}`, { ...entry, [p]: own(b, ["W1"]) }, at];
    }
    if (Object.hasOwn(entry, p)) {
      const { [p]: value, ...rest } = entry;
      yield [`${typo(p)} for ${p}`, { ...rest, [typo(p)]: value }, `rules[0].${typo(p)}`];
    }
    yield [
      `${typo(p)} beside ${p}`,
      { ...entry, [typo(p)]: entry[p] ?? "x" },
      `rules[0].${typo(p)}`,
    ];
  }
  if (!Object.hasOwn(params, "kind"))
    yield ["kind on a rule without", { ...entry, kind: "task" }, "rules[0].kind"];
  for (const b of BUILTINS) {
    yield [`param ${b}`, { ...entry, ...own(b, "x") }, `rules[0].${b}`];
    yield [`rule ${b}`, { ...entry, rule: b }, "rules[0].rule"];
  }
  yield ["rule misspelled", { ...entry, rule: typo(id) }, "rules[0].rule"];
}

for (const id of Object.keys(CATALOG)) {
  test(`${id}: every wrong value of every param is refused naming it, never OK`, () => {
    let n = 0;
    for (const [name, entry, at] of wrongEntries(id)) {
      n++;
      const r = judge(id, entry);
      assert.equal(r.exit, 2, `${id} ${name}: ${show(r)}`);
      assert.ok(
        r.messages.some((m) => m === at || [" ", ".", "["].some((c) => m.startsWith(at + c))),
        `${id} ${name} names ${at}: ${show(r)}`,
      );
    }
    assert.ok(n >= 10, `${id}: ${n} wrong entries`);
  });
}

test("a kind a rule can check besides its own still fires on its board, never OK", () => {
  for (const [id, kinds] of Object.entries(ACCEPTS))
    for (const k of kinds) {
      const r = judge(id, { rule: id, ...ENTRIES[id], kind: k });
      assert.equal(r.exit, 1, `${id} kind = ${k}: ${show(r)}`);
    }
});

test("a kind that lacks what the rule needs is refused naming the capability", () => {
  const cases = [
    [
      "parent-active",
      { kind: "sprint" },
      'kind names "sprint", which lacks a field with role "parent"',
    ],
    ["closed-children", { kind: "task" }, 'kind names "task", which lacks children'],
    [
      "closed-children",
      { kind: "milestone" },
      'kind names "milestone", which lacks a status field',
    ],
    ["sequential", { kind: "decision" }, 'kind names "decision", which lacks a status that can be'],
    [
      "members-listed",
      { member: "question" },
      'member names "question", which lacks a parent field',
    ],
    ["file-required", { kind: "task" }, 'kind names "task", which lacks its own file'],
    [
      "deps-not-forward",
      { kind: "decision", field: "z_list_self" },
      'kind names "decision", which lacks an order',
    ],
    [
      "parked",
      { kind: "question" },
      'kind names "question", which lacks a status that can be "parked"',
    ],
  ];
  for (const [id, params, message] of cases) {
    const r = judge(id, { rule: id, ...ENTRIES[id], ...params });
    assert.equal(r.exit, 2, `${id} ${JSON.stringify(params)}: ${show(r)}`);
    assert.ok(
      r.messages.some((m) => m.startsWith(`rules[0].${message}`)),
      `${message}: ${show(r)}`,
    );
  }
  const blocks = structuredClone(DECOYED);
  blocks.kinds.question.fields.blocks.ref = "decision";
  const r = judge(
    "question-blocks",
    { rule: "question-blocks", ...ENTRIES["question-blocks"] },
    blocks,
  );
  assert.equal(r.exit, 2, show(r));
  assert.match(
    r.messages[0],
    /^rules\[0\]\.field names the list field "blocks" of decision, and no kind it refs has a status that can be started/,
  );
});

test("file-required without a kind is refused where no kind's file is required", () => {
  const spec = structuredClone(DECOYED);
  spec.kinds.sprint.file.required = false;
  const r = judge("file-required", { rule: "file-required" }, spec);
  assert.equal(r.exit, 2, show(r));
  assert.match(r.messages[0], /^rules\[0\] is missing "kind", and no kind has a required file/);
  assert.equal(
    judge("file-required", { rule: "file-required" }).exit,
    1,
    "sprint's file is required",
  );
});

// Wrong values for the params that name items: each must show as a finding, not shift the result.
const STRAY = ["PREE", "TRKK", "Q-01", "N1", ...BUILTINS];

test("a skip or except value that names nothing on the board is a finding naming it", () => {
  let n = 0;
  for (const [id, rule] of Object.entries(CATALOG)) {
    const entry = { rule: id, ...ENTRIES[id] };
    const kinds = rule.kinds ? rule.kinds(DECOYED.kinds, entry) : [entry.kind];
    for (const [p, def] of Object.entries(rule.params)) {
      const keys =
        def.type === "except" ? ["id", ...Object.keys(DECOYED.kinds[kinds[0]].fields)] : [null];
      if (def.type !== "except" && !def.names) continue;
      for (const key of keys)
        for (const v of STRAY) {
          if (key && v === "Q-01" && kinds[0] === "question") continue;
          n++;
          const value = key
            ? { ...entry, [p]: own(key, [v]) }
            : { ...entry, [p]: [...entry[p], v] };
          const at = key ? `rules[0].${p}.${key}` : `rules[0].${p}`;
          const r = judge(id, value);
          assert.equal(r.exit, 1, `${id} ${at} ${v}: ${show(r)}`);
          assert.ok(
            r.messages.includes(`${id}: ${at} names no item "${v}"`),
            `${at} ${v}: ${show(r)}`,
          );
        }
    }
  }
  assert.ok(n > 300, `${n} stray values`);
});

test("through the board: a kind the rule cannot check is exit 2, a stray except value exit 1", () => {
  const root = roots["parent-active"];
  const file = join(root, "attack.json");
  const run = (rules, ...args) => {
    writeFileSync(file, JSON.stringify({ ...VALID, rules }));
    return spawnSync("node", [BOARD, "check", "--root", root, "--process", file, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
  };
  const refused = run([{ rule: "parent-active", kind: "sprint" }]);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(
    refused.stderr,
    /\n {2}rules\[0\]\.kind names "sprint", which lacks a field with role "parent"/,
  );
  assert.doesNotMatch(refused.stderr, /\n\s+at /);
  const stray = run(
    [{ rule: "parent-active", kind: "task", except: { sprint: ["B11"] } }],
    "--json",
  );
  assert.equal(stray.status, 1, stray.stderr);
  const messages = JSON.parse(stray.stdout).findings.map((f) => f.message);
  assert.ok(messages.includes('rules[0].except.sprint names no item "B11"'), messages.join(" | "));
  assert.ok(messages.includes("doing, but sprint B1 is todo"), "the rule still runs");
});

test("a param judged once the kind has a parent comes with the kind's parent need", () => {
  for (const [id, rule] of Object.entries(CATALOG)) {
    const onParent = Object.values(rule.params).some(
      (d) => d.type === "parent" || (d.type === "section" && d.of === "parent"),
    );
    if (onParent) assert.ok(rule.params.kind.needs.includes("parent"), id);
  }
});
