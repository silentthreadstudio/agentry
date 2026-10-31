// Tests for board.mjs, the CLI router, and its read subcommands (check, status, scan, explain,
// contract, next-id), run as a process on the synthetic fixtures: exit codes 0/1/2, the `--json`
// report, `--why`, argv passed to a subcommand untouched, and widths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("a built-in name (constructor, toString) is no kind, field or item to the subcommands", () => {
  const cases = [
    [["check", "--why", "constructor"], /^no item "constructor" on the board/],
    [["next-id", "constructor"], /^usage: next-id <kind>/],
    [["set", "toString", "W1", "status=done"], /^unknown kind "toString"/],
    [["set", "task", "W1", "constructor=x"], /^task has no field "constructor"/],
    [["set", "task", "W1", "status=hasOwnProperty"], /^"hasOwnProperty" is not a task status/],
    [["add", "toString", "--json", '{"id": "Z1"}'], /^unknown kind "toString"/],
  ];
  for (const [args, expected] of cases) {
    const out = run("table-board", ...args);
    assert.equal(out.status, 2, args.join(" "));
    assert.match(out.stderr, expected, args.join(" "));
  }
});

test("a board cell holding a built-in name reads as that word, not as a built-in", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-board-"));
  try {
    cpSync(join(FIXTURES, "table-board"), root, { recursive: true });
    const board = join(root, "docs", "board", "BOARD.md");
    const text = readFileSync(board, "utf8");
    writeFileSync(board, text.replace("| W4 | A2 | todo | W3 |", "| W4 | A2 | toString | W3 |"));
    const spec = loadSpec(join(root, "process.json")).spec;
    const model = readProcess({ root, spec });
    const w4 = model.kinds.task.items.find((i) => i.id === "W4");
    assert.equal(w4.phase, undefined);
    const found = check(model, [{ rule: "status-known" }], {});
    assert.deepEqual(
      found.map((f) => [f.id, f.message]),
      [["W4", "unknown status 'toString'"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// table-board copied into `<tmp>/repo`, beside `<tmp>/outside`, which holds a board-like secret.
function besideOutside() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "agentry-board-")));
  const root = join(tmp, "repo");
  const outside = join(tmp, "outside");
  cpSync(join(FIXTURES, "table-board"), root, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), "## Secret\n\n| Code |\n| --- |\n| SECRET-1 |\n");
  const sprint = join(root, "docs", "board", "sprints", "B1_the_door.md");
  cpSync(sprint, join(outside, "B1_the_door.md"));
  cpSync(join(root, "docs", "DECISIONS.md"), join(outside, "DECISIONS.md"));
  const cli = (...args) =>
    spawnSync("node", [BOARD, ...args, "--root", root], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
  return { tmp, root, outside, sprint, cli };
}

test("scan never reads through a symlink out of the repository", () => {
  const { tmp, root, outside, cli } = besideOutside();
  try {
    symlinkSync(outside, join(root, "lnk"));
    const dir = cli("scan", "lnk");
    assert.equal(dir.status, 2);
    assert.match(dir.stderr, /^"lnk" leaves the repository/);
    assert.doesNotMatch(dir.stdout + dir.stderr, /SECRET|Secret/);
    // git lists a tracked symlink like a file: it is listed as skipped, never read.
    symlinkSync(join(outside, "secret.md"), join(root, "docs", "leak.md"));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    for (const args of [
      ["init", "-q"],
      ["add", "-A"],
    ])
      assert.equal(spawnSync("git", ["-C", root, ...args], { env }).status, 0, args.join(" "));
    const all = cli("scan");
    assert.equal(all.status, 0);
    assert.match(all.stdout, /^scan · \. · \d+ files · .* · 1 skipped\n/);
    assert.match(all.stdout, /\ndocs\/leak\.md\n {2}skipped a symlink out of the repository/);
    assert.doesNotMatch(all.stdout, /SECRET|Secret/);
    const json = JSON.parse(cli("scan", "--json").stdout);
    assert.deepEqual(
      json.filter((f) => f.skipped).map((f) => f.file),
      ["docs/leak.md"],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a process-file path a symlink takes out is exit 2; a glob match out is a finding", () => {
  const { tmp, root, outside, sprint, cli } = besideOutside();
  const spec = ["--process", join(root, "process.json")];
  try {
    const decisions = join(root, "docs", "DECISIONS.md");
    rmSync(decisions);
    symlinkSync(join(outside, "DECISIONS.md"), decisions);
    const table = cli("check", ...spec);
    assert.equal(table.status, 2);
    assert.match(
      table.stderr,
      /\n {2}kinds\.decision\.at\.table "\.\.\/DECISIONS\.md" leaves the repository through a symlink/,
    );
    rmSync(decisions);
    cpSync(join(outside, "DECISIONS.md"), decisions);
    rmSync(sprint);
    symlinkSync(join(outside, "B1_the_door.md"), sprint);
    const glob = cli("check", "--json", ...spec);
    assert.equal(glob.status, 1);
    const messages = JSON.parse(glob.stdout).findings.map((f) => f.message);
    assert.ok(
      messages.includes("sprints/B1_the_door.md: a symlink out of the repository; not read"),
    );
    assert.ok(
      messages.some((m) => /^no file/.test(m)),
      "B1 reads as having no file",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

test("an option the subcommand does not take is a usage error with its usage line", () => {
  const cases = [
    [["check", "--bogus"], /^unknown option "--bogus"\nusage: check \[--json\] \[--why <id>\]\n$/],
    [["--bogus"], /^unknown option "--bogus"\nusage: status /],
    [["scan", "--bogus"], /^unknown option "--bogus"\nusage: scan /],
    [["explain", "--why", "W3"], /^unknown option "--why"\nusage: explain \[--json\]/],
    [["set", "task", "W1", "status=done", "--force"], /^unknown option "--force"\nusage: set /],
    [["check", "--json=yes"], /^--json takes no value\nusage: check /],
  ];
  for (const [args, expected] of cases) {
    const out = run("table-board", ...args);
    assert.equal(out.status, 2, args.join(" "));
    assert.match(out.stderr, expected, args.join(" "));
    assert.equal(out.stdout, "", args.join(" "));
  }
});

test("--flag=value reads as --flag value, the router's options included", () => {
  const why = run("table-board", "check", "--why=W3");
  assert.equal(why.stdout, run("table-board", "check", "--why", "W3").stdout);
  assert.match(why.stdout, /^W3 /);
  const root = join(FIXTURES, "table-board");
  const argv = [BOARD, "check", `--root=${root}`, `--process=${join(root, "process.json")}`];
  const out = spawnSync("node", argv, { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const empty = spawnSync("node", [BOARD, "check", "--root="], { encoding: "utf8" });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /^--root needs a value/);
});

test("--why with no id is a usage error, not a plain run", () => {
  for (const sub of ["check", "status"])
    for (const args of [["--why"], ["--why", "--json"]]) {
      const out = run("evidence-board", sub, ...args);
      assert.equal(out.status, 2, `${sub} ${args}`);
      assert.match(out.stderr, /^usage: (check|status) .*--why <id>/, sub);
    }
});

test("scan refuses a directory outside the repository root", () => {
  const root = join(FIXTURES, "table-board");
  for (const dir of ["..", "../evidence-board", "docs/../../evidence-board", "/tmp"]) {
    const out = spawnSync("node", [BOARD, "scan", dir, "--root", root], { encoding: "utf8" });
    assert.equal(out.status, 2, dir);
    assert.match(out.stderr, /leaves the repository/, dir);
  }
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
