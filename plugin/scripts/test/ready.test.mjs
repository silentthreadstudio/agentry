// Tests for `board status --ready` (lib/process/ready.mjs), on the evidence-board fixture: which open
// tasks have a contract and finished dependencies, as text and as JSON.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// A copy of the board where H1 waits on a finished task and carries the flag column, as `{ ctx }`.
function flagged() {
  const dir = mkdtempSync(join(tmpdir(), "agentry-ready-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const board = join(dir, "notes", "release", "BOARD.md");
  const lines = readFileSync(board, "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith("| Task |"));
  const out = lines.map((l, i) => {
    if (i < at || !l.startsWith("|") || i > at + 11) return l;
    if (i === at) return `${l} Flag |`;
    if (i === at + 1) return `${l} --- |`;
    return l.startsWith("| H1 ") ? `${l.replace("| K0 | |", "| K0-1 | |")} * |` : `${l} |`;
  });
  writeFileSync(board, out.join("\n"));
  const raw = JSON.parse(readFileSync(join(dir, "process.json"), "utf8"));
  raw.kinds.task.fields.flag = { column: "Flag", type: "flag", mark: "*" };
  writeFileSync(join(dir, "process.json"), JSON.stringify(raw));
  const { spec: copySpec } = loadSpec(join(dir, "process.json"));
  const copy = { root: dir, spec: copySpec, model: readProcess({ root: dir, spec: copySpec }) };
  after(() => rmSync(dir, { recursive: true, force: true }));
  return copy;
}
const rows = (res) =>
  Object.fromEntries(JSON.parse(res.out).ready.flatMap((g) => g.tasks.map((t) => [t.id, t])));

test("--ready --json rows carry the task's title and its flag", () => {
  const copy = flagged();
  const flat = rows(run(["--ready", "--json"], copy));
  assert.equal(flat.H1.title, "First lane");
  assert.equal(flat.H1.flag, true);
  assert.equal(flat.H2.flag, false);
});

test("--ready --sprint keeps one sprint's tasks, in any case", () => {
  const copy = flagged();
  const res = run(["--ready", "--json", "--sprint", "k1a"], copy);
  assert.equal(res.exit, 0, res.out);
  assert.deepEqual(Object.keys(rows(res)), ["H1", "H2"]);
});

test("--ready --sprint refuses an id that is not on the board and a missing id", () => {
  const unknown = run(["--ready", "--sprint", "K9"], ctx);
  assert.equal(unknown.exit, 2);
  assert.match(unknown.out, /^✗ board status: no sprint "K9" on the board/);
  assert.equal(run(["--ready", "--sprint"], ctx).exit, 2);
});

test("--startable keeps the planned tasks with a contract and finished dependencies", () => {
  const copy = flagged();
  const all = rows(run(["--ready", "--json"], copy));
  assert.equal(all.H1.deps, true, "H1 waits on a done task in the copy");
  const only = rows(run(["--ready", "--json", "--startable"], copy));
  assert.deepEqual(Object.keys(only), ["H1"]);
  assert.equal(only.H1.status, "todo");
});

test("--startable with --sprint combines, and with no startable task prints an empty view", () => {
  const none = run(["--ready", "--json", "--startable", "--sprint", "K0"], flagged());
  assert.deepEqual(JSON.parse(none.out).ready, []);
  assert.match(run(["--ready", "--startable"], ctx).out, /0 of 0 open tasks ready/);
});

test("--sprint and --startable without --ready are a usage error", () => {
  for (const flag of ["--startable", "--sprint K0"]) {
    const res = run(flag.split(" "), ctx);
    assert.equal(res.exit, 2);
    assert.match(res.out, /go with --ready/);
  }
});
