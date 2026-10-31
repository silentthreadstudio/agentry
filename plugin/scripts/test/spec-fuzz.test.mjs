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
