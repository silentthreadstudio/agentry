// The `lanes` block of `board explain`: which lanes a repo has wired, each ✓ or ✗ with the command that
// sets it. Run as a process on a git repo built from the synthetic table board. A missing lane never
// changes the exit code.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, "..", "board.mjs");

// A git repo holding the table board, whose process file gets `extra` keys. Returns `board` to run a
// subcommand on it and `lanes()` for explain's lane rows by name.
function repo(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentry-lanes-"));
  cpSync(join(HERE, "fixtures", "table-board"), root, { recursive: true });
  const file = join(root, "process.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...extra }));
  execFileSync("git", ["-C", root, "init", "-q"]);
  const board = (...args) =>
    spawnSync("node", [BOARD, ...args, "--root", root, "--process", file], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
  const lanes = () =>
    Object.fromEntries(JSON.parse(board("explain", "--json").stdout).lanes.map((l) => [l.lane, l]));
  return { root, board, lanes };
}

const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

test("a repo with no lanes set up lists each as ✗ with its command, and still exits 0", () => {
  const { root, board, lanes } = repo();
  try {
    const res = board("explain");
    assert.equal(res.status, 0);
    const block = res.stdout.split("\nlanes")[1];
    assert.ok(block, "a lanes block follows the rules");
    for (const lane of ["gate", "conductor.prompt", "trigger block", "default agent", "merge.push"])
      assert.match(block, new RegExp(`^✗ +${lane.replace(".", "\\.")} `, "m"), lane);
    assert.match(block, /set: board instructions --write/);
    assert.match(block, /set: board default-agent --write/);
    assert.match(block, /set: \/agentry:config merge\.push=/);
    const rows = lanes();
    assert.equal(rows.gate.ok, false);
    assert.equal(rows["merge.checks"].ok, false);
    assert.equal(rows["process version"].ok, true);
    assert.match(rows["process version"].value, /^1 · plugin \d/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lanes block fits 80 columns", () => {
  const { root, board } = repo({
    gate: {
      command: ["tools/ci/gate.sh", "--with-a-long-flag-name", "--and-another-long-flag-name"],
      quick: { command: ["tools/ci/gate.sh", "--quick"], only: ["docs/**", "**/*.md"] },
    },
  });
  try {
    const block = board("explain").stdout.split("\nlanes")[1];
    for (const line of block.split("\n")) assert.ok([...line].length <= 80, line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each lane turns ✓ once it is wired", () => {
  const { root, board, lanes } = repo({
    gate: { command: ["make", "check"], quick: { command: ["make", "docs"], only: ["docs/**"] } },
    extensions: { merge: { checks: ["repo-merge"] } },
    conductor: { prompt: "CONDUCTOR.md", rules: "Standing rules" },
  });
  try {
    write(root, "CONDUCTOR.md", "# Conductor\n\n## Standing rules\n\n- one\n");
    write(root, ".agentry/config.json", JSON.stringify({ merge: { push: "auto" } }));
    assert.equal(board("instructions", "--write").status, 0);
    assert.equal(board("default-agent", "--write").status, 0);
    const rows = lanes();
    for (const lane of [
      "gate",
      "gate.quick",
      "conductor.prompt",
      "conductor.rules",
      "trigger block",
      "default agent",
      "merge.push",
      "merge.checks",
    ])
      assert.equal(rows[lane].ok, true, lane);
    assert.equal(rows.gate.value, "make check");
    assert.equal(rows["conductor.rules"].value, "Standing rules (line 3)");
    assert.equal(rows["merge.push"].value, "auto");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trigger block that is out of date, or a bad default agent, is ✗", () => {
  const { root, board, lanes } = repo({ conductor: { prompt: "CONDUCTOR.md" } });
  try {
    write(root, "CONDUCTOR.md", "# Conductor\n");
    assert.equal(board("instructions", "--write").status, 0);
    write(root, ".claude/settings.json", JSON.stringify({ agent: "other:agent" }));
    write(root, "AGENTS.md", readFileSync(join(root, "AGENTS.md"), "utf8").replace("every", "any"));
    const rows = lanes();
    assert.deepEqual(
      [rows["trigger block"].ok, rows["trigger block"].value],
      [false, "out of date"],
    );
    assert.deepEqual(
      [rows["default agent"].ok, rows["default agent"].value],
      [false, "other:agent"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the .agentry commit policy is shown per subfolder: tracked, ignored or undecided", () => {
  const { root, lanes } = repo();
  try {
    write(root, ".gitignore", ".agentry/run/\n");
    write(root, ".agentry/process.json", "{}");
    write(root, ".agentry/memory/m.md", "x");
    write(root, ".agentry/NOTE.md", "x");
    execFileSync("git", ["-C", root, "add", ".agentry/process.json", ".agentry/memory"]);
    const rows = lanes();
    const state = (name) => [rows[`.agentry/${name}`].ok, rows[`.agentry/${name}`].value];
    assert.deepEqual(state("process.json"), [true, "tracked"]);
    assert.deepEqual(state("memory"), [true, "tracked"]);
    assert.deepEqual(state("run"), [true, "ignored"]);
    assert.deepEqual(state("NOTE.md"), [false, "undecided"]);
    assert.equal(rows[".agentry/NOTE.md"].set, "git add .agentry/NOTE.md");
    assert.equal(rows[".agentry/work"].set, "echo .agentry/work/ >> .gitignore");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
