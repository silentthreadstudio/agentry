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
import { explain } from "../lib/process/cli/explain.mjs";
import { findContract } from "../lib/process/contract.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import { writeSpec } from "./spec-files.mjs";

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
    [["check", "--why", "constructor"], /^✗ --why constructor: no item "constructor" on the board/],
    [["next-id", "constructor"], /^✗ board next-id: unknown kind "constructor"/],
    [["set", "toString", "W1", "status=done"], /^✗ board set: unknown kind "toString"/],
    [["set", "task", "W1", "constructor=x"], /^✗ board set: task has no field "constructor"/],
    [
      ["set", "task", "W1", "status=hasOwnProperty"],
      /^✗ board set: "hasOwnProperty" is not a task status/,
    ],
    [["add", "toString", "--fields", '{"id": "Z1"}'], /^✗ board add: unknown kind "toString"/],
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
    assert.match(dir.stderr, /^✗ board scan: "lnk" leaves the repository/);
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

test("a conductor prompt that a symlink takes out of the repository is exit 2", () => {
  const { tmp, root, outside, cli } = besideOutside();
  try {
    const file = join(root, "process.json");
    const spec = JSON.parse(readFileSync(file, "utf8"));
    writeSpec(root, { ...spec, conductor: { prompt: "CONDUCTOR.md" } });
    symlinkSync(join(outside, "secret.md"), join(root, "CONDUCTOR.md"));
    const res = cli("check", "--process", file);
    assert.equal(res.status, 2);
    assert.match(
      res.stderr,
      /conductor\.prompt "CONDUCTOR\.md" leaves the repository through a symlink/,
    );
    assert.doesNotMatch(res.stdout + res.stderr, /SECRET/);
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
  assert.match(
    broken.stderr,
    /cannot use the process file → \/agentry:init\n {2}kinds\.task\.fields\.deps\.type/,
  );
  const root = join(FIXTURES, "table-board");
  const empty = mkdtempSync(join(tmpdir(), "agentry-board-"));
  try {
    const kindless = { version: 1, name: "E", root: ".", kinds: {}, rules: [] };
    writeSpec(empty, kindless);
    for (const sub of ["check", "status"]) {
      const argv = [BOARD, sub, "--root", empty, "--process", join(empty, "process.json")];
      const res = spawnSync("node", argv, {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      assert.equal(res.status, 2, sub);
      assert.match(
        res.stderr,
        /cannot use the process file → \/agentry:init\n {2}kinds should name at least one kind/,
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
  assert.match(missing.stderr, /no process file here → \/agentry:init/);
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
    [["check", "--bogus"], /^✗ board check: unknown option "--bogus" → board check --help\n$/],
    [["--bogus"], /^✗ board status: unknown option "--bogus" → board status --help/],
    [["scan", "--bogus"], /^✗ board scan: unknown option "--bogus" → board scan --help/],
    [["explain", "--why", "W3"], /^✗ board explain: unknown option "--why" → board explain --help/],
    [
      ["set", "task", "W1", "status=done", "--force"],
      /^✗ board set: unknown option "--force" → board set --help/,
    ],
    [["check", "--json=yes"], /^✗ board check: --json takes no value → board check --help/],
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
  assert.match(empty.stderr, /^✗ board: --root needs a value → board --help/);
});

test("--why with no id is a usage error, not a plain run", () => {
  for (const sub of ["check", "status"])
    for (const args of [["--why"], ["--why", "--json"]]) {
      const out = run("evidence-board", sub, ...args);
      assert.equal(out.status, 2, `${sub} ${args}`);
      assert.match(out.stderr, /^✗ board (check|status): --why needs an id → board \1 --help/);
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

test("explain counts unknown status words named like built-ins as plain words", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-explain-"));
  try {
    cpSync(join(FIXTURES, "table-board"), root, { recursive: true });
    const board = join(root, "docs", "board", "BOARD.md");
    const text = readFileSync(board, "utf8")
      .replace("| W4 | A2 | todo |", "| W4 | A2 | toString |")
      .replace("| W5 | B1 | todo |", "| W5 | B1 | __proto__ |")
      .replace("| X-01 | TRK | doing |", "| X-01 | TRK | toString |");
    writeFileSync(board, text);
    const { spec } = loadSpec(join(root, "process.json"));
    const data = explain({ root, spec, model: readProcess({ root, spec }) });
    const task = data.kinds.find((k) => k.kind === "task");
    assert.deepEqual(Object.entries(task.unknownStatus), [
      ["toString", 2],
      ["__proto__", 1],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("next-id: the next number of the pattern; exit 2 when ids are asked", () => {
  const next = run("table-board", "next-id", "question");
  assert.deepEqual([next.status, next.stdout], [0, "Q-03\n"]);
  assert.equal(run("table-board", "next-id", "task").status, 2);
  const json = run("table-board", "next-id", "question", "--json");
  assert.deepEqual(JSON.parse(json.stdout), { kind: "question", id: "Q-03" });
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
    const argv = [BOARD, "add", "question", "--fields", fields, "--apply", "--root", root];
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

// The templates in `dir` load and make a board every enabled rule passes.
function templatesPass(dir) {
  const { spec, problems } = loadSpec(join(dir, "process.json"));
  assert.deepEqual(problems, []);
  const here = { ...spec, root: "." };
  const model = readProcess({ root: dir, spec: here });
  assert.deepEqual(model.problems, []);
  const ctx = {
    hasCommit: () => false,
    contractOf: (kind, id) => findContract({ root: dir, spec: here, id, kind }),
  };
  assert.deepEqual(check(model, spec.rules, ctx), []);
  return model;
}

test("the process skill's templates make a board every enabled rule passes", () => {
  const model = templatesPass(TEMPLATES);
  assert.deepEqual(
    model.kinds.debt.items.map((i) => [i.id, i.status]),
    [["DEBT-1", "todo"]],
  );
});

test("the templates still pass with the debt pieces dropped as learn.md says", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-templates-"));
  try {
    cpSync(TEMPLATES, dir, { recursive: true });
    const edit = (file, change) =>
      writeFileSync(join(dir, file), change(readFileSync(join(dir, file), "utf8")));
    edit("process.json", (text) => {
      const board = JSON.parse(text);
      board.kinds.debt = undefined;
      board.rules = board.rules.filter((r) => r.kind !== "debt");
      return JSON.stringify(board, null, 2);
    });
    edit("workflow.json", (text) => {
      const workflow = JSON.parse(text);
      const { debt: _debt, ...kinds } = workflow.exec.kinds;
      const { kinds: _kinds, ...exec } = workflow.exec;
      const rest = Object.keys(kinds).length ? { ...exec, kinds } : exec;
      workflow.exec = Object.keys(rest).length ? rest : undefined;
      return JSON.stringify(workflow, null, 2);
    });
    edit("BOARD.md", (text) => text.replace(/## Debt\n[\s\S]*?(?=\n## )/, ""));
    edit("TASKS.md", (text) => text.replace(/^# Debt\n[\s\S]*?(?=^# )/m, ""));
    const model = templatesPass(dir);
    assert.equal(model.kinds.debt, undefined);
    assert.doesNotMatch(readFileSync(join(dir, "BOARD.md"), "utf8"), /Debt|DEBT/);
    assert.doesNotMatch(readFileSync(join(dir, "TASKS.md"), "utf8"), /Debt|DEBT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan with no dir ends by naming the ignored folders it did not read", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "agentry-scan-")));
  try {
    const table = "| Code |\n| --- |\n| T1 |\n";
    for (const dir of ["docs", ".notes/a", "node_modules/x", ".agentry/run"]) {
      mkdirSync(join(tmp, dir), { recursive: true });
      writeFileSync(join(tmp, dir, "b.md"), table);
    }
    // An ignored folder is named whether or not it holds markdown: none is walked to find out.
    mkdirSync(join(tmp, "scratch"));
    writeFileSync(join(tmp, "scratch", "a.txt"), "x");
    writeFileSync(join(tmp, ".gitignore"), ".notes/\nnode_modules/\n.agentry/\nscratch/\n");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    for (const args of [
      ["init", "-q"],
      ["add", "docs", ".gitignore"],
    ])
      spawnSync("git", ["-C", tmp, ...args], { env });
    const cli = (...args) =>
      spawnSync("node", [BOARD, "scan", ...args, "--root", tmp], {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });
    const all = cli();
    assert.match(
      all.stdout,
      /\nnot scanned \(ignored\): \.notes, scratch → .*board scan <dir>\/…\n$/,
    );
    assert.doesNotMatch(all.stdout, /node_modules|\.agentry/);
    assert.doesNotMatch(cli(".notes").stdout, /not scanned/);
    assert.doesNotMatch(cli("--json").stdout, /not scanned/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scan points at the first ignored folder by name, counts the rest and skips tool folders", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "agentry-scan-")));
  try {
    const table = "| Code |\n| --- |\n| T1 |\n";
    const files = {
      ".a": 1,
      ".c": 1,
      ".d": 1,
      ".e": 1,
      ".zbig": 3,
      ".claude": 9,
      venv: 9,
    };
    for (const [dir, n] of Object.entries(files))
      for (let i = 0; i < n; i++) {
        mkdirSync(join(tmp, dir), { recursive: true });
        writeFileSync(join(tmp, dir, `b${i}.md`), table);
      }
    writeFileSync(join(tmp, ".gitignore"), `${Object.keys(files).join("/\n")}/\n`);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    spawnSync("git", ["-C", tmp, "init", "-q"], { env });
    const res = spawnSync("node", [BOARD, "scan", "--root", tmp], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(
      res.stdout,
      /\nnot scanned \(ignored\): \.a, \.c, \.d, \+2 more → .*board scan <dir>\/…\n$/,
    );
    assert.doesNotMatch(res.stdout, /\.claude|venv/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scan moves the arrow and command to an indented next line when the not-scanned line would pass 100 columns", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "agentry-scan-")));
  try {
    const table = "| Code |\n| --- |\n| T1 |\n";
    const long = (c) => `.${c.repeat(60)}`;
    const files = { [long("b")]: 3, [long("a")]: 2, [`.${"c".repeat(120)}`]: 1 };
    for (const [dir, n] of Object.entries(files))
      for (let i = 0; i < n; i++) {
        mkdirSync(join(tmp, dir), { recursive: true });
        writeFileSync(join(tmp, dir, `b${i}.md`), table);
      }
    writeFileSync(join(tmp, ".gitignore"), `${Object.keys(files).join("/\n")}/\n`);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    spawnSync("git", ["-C", tmp, "init", "-q"], { env });
    const res = spawnSync("node", [BOARD, "scan", "--root", tmp], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const [line, next] = res.stdout.trimEnd().split("\n").slice(-2);
    assert.match(line, /^not scanned \(ignored\): .*\+\d more$/);
    assert.ok([...line].length <= 100, line);
    assert.match(next, /^ {2}→ .*board scan <dir>\/…$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scan keeps the arrow whole under a 140-column folder, the folder cut on the line above", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "agentry-scan-")));
  try {
    const dir = `.${"d".repeat(139)}`;
    mkdirSync(join(tmp, dir), { recursive: true });
    writeFileSync(join(tmp, dir, "b.md"), "| Code |\n| --- |\n| T1 |\n");
    writeFileSync(join(tmp, ".gitignore"), `${dir}/\n`);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    spawnSync("git", ["-C", tmp, "init", "-q"], { env });
    const res = spawnSync("node", [BOARD, "scan", "--root", tmp], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const [line, next] = res.stdout.trimEnd().split("\n").slice(-2);
    assert.match(line, /^not scanned \(ignored\): .*…$/);
    assert.ok([...line].length <= 100, line);
    assert.match(next, /^ {2}→ .*board scan <dir>\/…$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
