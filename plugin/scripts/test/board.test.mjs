// Tests for board.mjs, the CLI router, and its read subcommands (check, status, scan, explain,
// contract, next-id), run as a process on the synthetic fixtures: exit codes 0/1/2, the `--json`
// report, `--why`, argv passed to a subcommand untouched, and widths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "../lib/process/check.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, "..", "board.mjs");
const FIXTURES = join(HERE, "fixtures");
const TEMPLATES = join(HERE, "..", "..", "skills", "process", "templates");

const run = (fixture, ...args) => {
  const root = join(FIXTURES, fixture);
  const argv = [BOARD, ...args, "--root", root, "--process", join(root, "process.json")];
  return spawnSync("node", argv, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
};
const cols = (text) => Math.max(0, ...text.split("\n").map((l) => [...l].length));

test("check: exit 0 and the OK line on a clean board, exit 1 with findings", () => {
  const ok = run("table-board", "check");
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "✓ Sample  OK · 8 rules · 8 tasks · exit 0\n");
  const bad = run("evidence-board", "check");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout.split("\n")[0], /^✗ Release {2}5 problems · .* · exit 1$/);
});

test("no subcommand is status: verdict first, then the Now block", () => {
  const out = run("table-board");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^✓ Sample {2}OK[^\n]*\n\nNow {8}A2 /);
});

test("--json is the BoardReport; status adds the view", () => {
  const report = JSON.parse(run("evidence-board", "check", "--json").stdout);
  assert.deepEqual(Object.keys(report), ["ok", "name", "root", "rules", "items", "findings"]);
  const withView = JSON.parse(run("evidence-board", "status", "--json").stdout);
  assert.deepEqual(
    withView.status.now.map((n) => n.id),
    ["K0"],
  );
});

test("--why <id> works on check and on status; an unknown id is exit 2", () => {
  for (const sub of ["check", "status"]) {
    const why = run("evidence-board", sub, "--why", "H2");
    assert.equal(why.status, 1, sub);
    assert.match(why.stdout, /^H2 {2}Second lane\n/);
  }
  assert.equal(run("evidence-board", "check", "--why", "K0-2").status, 0, "an item that holds");
  assert.equal(run("evidence-board", "--why", "NOPE").status, 2);
});

test("usage and process-file errors are exit 2, on stderr", () => {
  const unknown = run("table-board", "frobnicate");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown subcommand "frobnicate" \(subcommands: .*check.*\)/);
  const broken = run("broken", "check");
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /cannot use the process file\n {2}kinds\.task\.fields\.deps\.type/);
  const root = join(FIXTURES, "table-board");
  const empty = mkdtempSync(join(tmpdir(), "agentry-board-"));
  try {
    const kindless = { version: 1, name: "E", root: ".", kinds: {}, rules: [] };
    writeFileSync(join(empty, "process.json"), JSON.stringify(kindless));
    for (const sub of ["check", "status"]) {
      const argv = [BOARD, sub, "--root", empty, "--process", join(empty, "process.json")];
      const res = spawnSync("node", argv, {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      assert.equal(res.status, 2, sub);
      assert.match(
        res.stderr,
        /cannot use the process file\n {2}kinds should name at least one kind/,
      );
      assert.doesNotMatch(res.stderr, /TypeError|\.mjs:\d+/, "a problem, not a stack");
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  for (const args of [["--root"], ["--process"], ["--root", "--process", "x.json"]]) {
    const bare = spawnSync("node", [BOARD, "check", ...args], { encoding: "utf8", cwd: root });
    assert.equal(bare.status, 2, args.join(" "));
    assert.match(bare.stderr, /needs a value/);
  }
  const missing = spawnSync("node", [BOARD, "check", "--root", root], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /run \/agentry:init/);
});

test("scan needs no process file and lists every table with its row count", () => {
  const root = join(FIXTURES, "table-board");
  const out = spawnSync("node", [BOARD, "scan", "--root", root], { encoding: "utf8" });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^scan · \. · \d+ files · \d+ tables/);
  assert.match(out.stdout, /docs\/board\/BOARD\.md\n {2}table {3}:\d+ {2}\d+ rows {2}Milestones/);
  assert.match(out.stdout, /leads {3}\d+ \(W1, W3, W5/);
  assert.ok(cols(out.stdout) <= 100);
});

test("explain lists every kind with its count and every catalog rule on or off", () => {
  const out = run("table-board", "explain");
  assert.equal(out.status, 0);
  for (const kind of ["milestone", "sprint", "task", "question", "decision"])
    assert.match(out.stdout, new RegExp(`^${kind} .* \\d+ items`, "m"));
  assert.match(out.stdout, /^on {3}C3 deps-done/m);
  assert.ok(cols(out.stdout) <= 100);
  const data = JSON.parse(run("table-board", "explain", "--json").stdout);
  assert.equal(data.rules.length, 8 + data.rules.filter((r) => !r.on).length);
});

test("next-id: the next number of the pattern; exit 2 when ids are asked", () => {
  const next = run("table-board", "next-id", "question");
  assert.deepEqual([next.status, next.stdout], [0, "Q-03\n"]);
  assert.equal(run("table-board", "next-id", "task").status, 2);
});

test("contract: the block as one JSON line", () => {
  const out = run("table-board", "contract", "W5");
  assert.equal(out.status, 0);
  const found = JSON.parse(out.stdout);
  assert.deepEqual(
    [found.status, found.file, found.source],
    ["found", "docs/board/TASKS.md", "process"],
  );
  assert.match(found.block, /^\*\*W5 · The door\*\*/);
  assert.equal(run("table-board", "contract", "--kind", "task", "W5").status, 0, "with --kind");
  assert.equal(run("table-board", "contract", "W9").status, 1, "not found");
});

test("the router hands a subcommand its argv untouched (add takes --json <fields>)", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-board-"));
  try {
    cpSync(join(FIXTURES, "table-board"), root, { recursive: true });
    const fields = JSON.stringify({ id: "Q-03", question: "Ring the bell?", blocks: "W5" });
    const argv = [BOARD, "add", "question", "--json", fields, "--root", root];
    const out = spawnSync("node", [...argv, "--process", join(root, "process.json")], {
      encoding: "utf8",
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(
      readFileSync(join(root, "docs/board/BOARD.md"), "utf8"),
      /\| Q-03 \| Ring the bell\?/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the process skill's templates make a board every enabled rule passes", () => {
  const { spec, problems } = loadSpec(join(TEMPLATES, "process.json"));
  assert.deepEqual(problems, []);
  const model = readProcess({ root: TEMPLATES, spec: { ...spec, root: "." } });
  assert.deepEqual(model.problems, []);
  assert.deepEqual(check(model, spec.rules, { hasCommit: () => false }), []);
});
