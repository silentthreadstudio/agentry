// Tests for `board status --ready` (lib/process/ready.mjs), on the evidence-board fixture: which open
// tasks have a contract and finished dependencies, as text and as JSON.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../lib/process/cli/status.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import { WIDTH } from "../lib/process/render.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "evidence-board");
const root = mkdtempSync(join(tmpdir(), "agentry-ready-"));
after(() => rmSync(root, { recursive: true, force: true }));
cpSync(FIXTURE, root, { recursive: true });
const { spec } = loadSpec(join(FIXTURE, "process.json"));
const ctx = { root, processPath: undefined, spec, model: readProcess({ root, spec }) };

test("--ready --json lists the open tasks of each sprint with contract and deps as booleans", () => {
  const res = run(["--ready", "--json"], ctx);
  assert.equal(res.exit, 0);
  const { ready } = JSON.parse(res.out);
  const flat = Object.fromEntries(ready.flatMap((g) => g.tasks.map((t) => [t.id, t])));
  assert.deepEqual(Object.keys(flat).sort(), ["H1", "H2", "H3", "K0-4"]);
  assert.equal(flat.H1.contract, true);
  assert.equal(flat.H1.deps, false, "H1 waits on K0");
  assert.equal(flat["K0-4"].contract, false);
  assert.equal(flat["K0-4"].deps, true);
  assert.deepEqual(
    ready.map((g) => g.id),
    ["K0", "K1a", "K1b"],
  );
});

test("--ready prints y/n columns under each sprint, within 80 columns", () => {
  const res = run(["--ready"], ctx);
  assert.equal(res.exit, 0);
  assert.match(res.out, /^Release {2}0 of 4 open tasks ready/);
  assert.match(res.out, /^ {2}H1 +todo +contract y +deps n$/m);
  assert.match(res.out, /^ {2}K0-4 +verify +contract n +deps y$/m);
  assert.ok(res.out.split("\n").every((l) => [...l].length <= WIDTH));
});
