// Tests for lib/process/contract.mjs and find-contract.mjs: an item's contract block by id, through the
// process file's blocks, Agentry task files and discovered TASKS.md; and the tracked-file discovery
// `scan` shares with it. Invented ids and words only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { scan } from "../lib/process/cli/scan.mjs";
import { blocksIn, findContract } from "../lib/process/contract.mjs";
import { BASE } from "./key-cases.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "find-contract.mjs");
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function repo(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentry-contract-")));
  dirs.push(root);
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
// A real git repository: `tracked` files are committed, `loose` ones only written.
function gitRepo(tracked, loose) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentry-contract-")));
  dirs.push(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => {
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env });
    assert.equal(res.status, 0, res.stderr);
  };
  git("init", "-q");
  for (const [path, text] of Object.entries({ ...tracked, ...loose })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git("add", "--", ...Object.keys(tracked));
  return root;
}

const BOLD = [
  "# Contracts",
  "",
  "- **KX-01a** (S1): owns the door · accept: it opens.",
  "  **the seam:** the hinge stays.",
  "- **KX-01b** (S1): owns the frame.",
  "- **KX-02 splits.** **KX-02a** (S2): owns the bell",
  "  and its rope. **KX-02b** (later): the second bell.",
  "- **KX-03** (S2): owns the lamp.",
  "",
  "## Later",
  "**KX-09 · The cellar** · owns the stairs.",
].join("\n");

test("a bold-lead block runs to the next block start, emphasis included", () => {
  const [hit] = blocksIn(BOLD, "KX-01a");
  assert.equal(hit.line, 3);
  assert.equal(
    hit.block,
    "- **KX-01a** (S1): owns the door · accept: it opens.\n  **the seam:** the hinge stays.",
  );
});

test("ids match exactly: a prefix id is not found inside a longer one", () => {
  assert.deepEqual(blocksIn(BOLD, "KX-01"), []);
  assert.equal(blocksIn(BOLD, "KX-01b")[0].line, 5);
});

test("a bold start after a sentence opens a block at its lead and ends at the next id lead", () => {
  const [hit] = blocksIn(BOLD, "KX-02a");
  assert.equal(hit.line, 6);
  assert.equal(hit.block, "**KX-02a** (S2): owns the bell\n  and its rope.");
  assert.equal(blocksIn(BOLD, "KX-02b")[0].block, "**KX-02b** (later): the second bell.");
});

test("a block that starts inside the previous task's paragraph carries none of its text", () => {
  const text = [
    "- **KX-50 splits.** **KX-50a** (S1): owns the door,",
    "  the hinge and the frame · accept: it opens. **KX-50b** (later): the second door",
    "  · deps KX-50a.",
    "- **KX-51** (S1): owns the lamp.",
  ].join("\n");
  assert.equal(
    blocksIn(text, "KX-50a")[0].block,
    "**KX-50a** (S1): owns the door,\n  the hinge and the frame · accept: it opens.",
  );
  assert.deepEqual(blocksIn(text, "KX-50b"), [
    { line: 2, block: "**KX-50b** (later): the second door\n  · deps KX-50a.", title: false },
  ]);
});

test("ids are looked up without regard to case", () => {
  assert.equal(blocksIn(BOLD, "kx-01a")[0].line, 3);
  assert.deepEqual(blocksIn(BOLD, "kx-01"), [], "still exact apart from case");
});

test("a ``` line inside a ~~~ fence opens no block and closes nothing: the block after the fence is found", () => {
  const text = [
    "~~~md",
    "```",
    "- **KX-60** (S1): an example, not a contract.",
    "~~~",
    "- **KX-61** (S1): owns the real one.",
  ].join("\n");
  assert.deepEqual(blocksIn(text, "KX-60"), []);
  assert.deepEqual(blocksIn(text, "KX-61"), [
    { line: 5, block: "- **KX-61** (S1): owns the real one.", title: false },
  ]);
});

const ROWS = [
  "- **KX-30** (S1): owns the felt.",
  "",
  "## Art",
  "",
  "| Art | Sprint | What |",
  "| --- | --- | --- |",
  "| KX-31 | later | The felt and the chips |",
  "| **KX-32** | S2 | The wheel |",
].join("\n");

test("a table row whose first cell is the id is its block, and ends the block above", () => {
  assert.deepEqual(blocksIn(ROWS, "KX-31", ["bold"]), [
    { line: 7, block: "| KX-31 | later | The felt and the chips |", title: false },
  ]);
  assert.equal(blocksIn(ROWS, "KX-32")[0].line, 8);
  assert.deepEqual(blocksIn(ROWS, "later"), [], "only the first cell names a row");
  assert.doesNotMatch(blocksIn(ROWS, "KX-30")[0].block, /KX-31/);
});

test("a bold block ends where a table starts, even one with no id rows", () => {
  const text =
    "**KX-33 · Smoke** · owns the sweep\n\n| Wave | Lane |\n| --- | --- |\n| one | KX-33 |\n";
  assert.equal(blocksIn(text, "KX-33")[0].block, "**KX-33 · Smoke** · owns the sweep");
  const heading = "### KX-34 · Door\n| Field | Value |\n| --- | --- |\n| owns | the door |\n";
  assert.match(blocksIn(heading, "KX-34")[0].block, /owns \| the door/, "a heading block keeps it");
});

test("a bold block ends at any heading; a heading block at one of its level", () => {
  assert.equal(blocksIn(BOLD, "KX-03")[0].block, "- **KX-03** (S2): owns the lamp.");
  const text = "## S1 · One\n### F7 · Door\n- **Owns:** a\n- **Accept:** b\n### F8 · Bell\nx";
  assert.equal(blocksIn(text, "F7")[0].block, "### F7 · Door\n- **Owns:** a\n- **Accept:** b");
  assert.deepEqual(blocksIn(text, "F7", ["bold"]), [], "lead limits which starts count");
});

test("a titled contract beats a bare amendment line in an earlier file; the line is related", () => {
  const root = repo({
    "board/TASKS.md": "- **KX-05** deps KX-04 (was KX-03).\n",
    "plans/OLD.md": "**KX-05 · The original** · owns it.\n",
    "TASKS.md": "- **KX-05** a discovered copy\n",
  });
  const spec = {
    root: "board",
    kinds: { task: { contract: { blocks: ["TASKS.md", "../plans/OLD.md"] } } },
  };
  const found = findContract({ root, spec, id: "KX-05" });
  assert.deepEqual(
    { ...found, block: undefined },
    {
      status: "found",
      id: "KX-05",
      file: "plans/OLD.md",
      line: 1,
      source: "process",
      block: undefined,
      related: [{ file: "board/TASKS.md", line: 1 }],
    },
  );
});

// An amendment file before the plan file, as a board that amends an older plan lays them out.
const amended = (amendment, original) =>
  findContract({
    root: repo({ "board/TASKS.md": amendment, "plans/OLD.md": original }),
    spec: {
      root: "board",
      kinds: { task: { contract: { blocks: ["TASKS.md", "../plans/OLD.md"] } } },
    },
    id: "KX-22",
  });

test("an amendment that only says `accept as …` loses to the titled contract", () => {
  const found = amended(
    "- **KX-22** deps only KX-20 · accept as OLD, plus the bell rings.\n",
    "**KX-22 · The bell** · owns `bell.mjs` · accept: it rings.\n",
  );
  assert.deepEqual([found.status, found.file], ["found", "plans/OLD.md"]);
});

test("two real contracts are ambiguous, never a silent pick", () => {
  const found = amended(
    "- **KX-22** (S1): owns the rope · accept: it pulls.\n",
    "**KX-22 · The bell** · owns `bell.mjs` · accept: it rings.\n",
  );
  assert.deepEqual(found, {
    status: "ambiguous",
    id: "KX-22",
    candidates: [
      { file: "board/TASKS.md", line: 1 },
      { file: "plans/OLD.md", line: 1 },
    ],
  });
});

test("a bare block with no real contract anywhere is still found", () => {
  const found = amended("- **KX-22** (S1) · moments: the bell and the rope.\n", "# Plan\n");
  assert.deepEqual([found.status, found.file], ["found", "board/TASKS.md"]);
});

test("without a process file: Agentry task files by frontmatter id, then discovered TASKS.md", () => {
  const root = repo({
    ".agentry/work/run1/tasks/t3.md": "---\nid: KX-07\n---\n# Seven\nbody\n",
    "docs/TASKS.md": "### KX-08 · Eight\ntext\n",
  });
  const agentry = findContract({ root, id: "KX-07" });
  assert.equal(agentry.source, "agentry");
  assert.equal(agentry.file, ".agentry/work/run1/tasks/t3.md");
  const discovered = findContract({ root, id: "KX-08" });
  assert.deepEqual(
    [discovered.source, discovered.file, discovered.block],
    ["discovered", "docs/TASKS.md", "### KX-08 · Eight\ntext"],
  );
});

test("two hits in the discovered tier are ambiguous; no hit is not-found", () => {
  const root = repo({ "a/TASKS.md": "- **KX-04** one\n", "b/TASKS.md": "- **KX-04** two\n" });
  assert.deepEqual(findContract({ root, id: "KX-04" }), {
    status: "ambiguous",
    id: "KX-04",
    candidates: [
      { file: "a/TASKS.md", line: 1 },
      { file: "b/TASKS.md", line: 1 },
    ],
  });
  assert.deepEqual(findContract({ root, id: "KX-99" }), {
    status: "not-found",
    id: "KX-99",
    candidates: [],
  });
});

test("in a git repository only tracked TASKS.md are discovered", () => {
  const root = gitRepo(
    { "docs/TASKS.md": "- **KX-05** tracked\n" },
    { "scratch/TASKS.md": "- **KX-05** a loose copy\n" },
  );
  const found = findContract({ root, id: "KX-05" });
  assert.deepEqual([found.status, found.file], ["found", "docs/TASKS.md"]);
});

test("scan lists the tracked markdown of a git repository; a named directory is read from disk", () => {
  const table = "## Tasks\n\n| Task |\n| --- |\n| KX-1 |\n";
  const root = gitRepo({ "docs/BOARD.md": table }, { "notes/BOARD.md": table });
  assert.deepEqual(
    scan(root).map((f) => f.file),
    ["docs/BOARD.md"],
  );
  assert.deepEqual(
    scan(root, "notes").map((f) => f.file),
    ["notes/BOARD.md"],
  );
});

test("find-contract.mjs prints one JSON line; exit 0 found, 1 not found, 2 usage", () => {
  const root = repo({
    ".agentry/process.json": JSON.stringify({
      version: 1,
      name: "X",
      root: "w",
      kinds: {
        task: {
          label: "Task",
          at: { table: "B.md", heading: "Tasks" },
          id: { column: "Task" },
          contract: { blocks: ["TASKS.md"] },
        },
      },
      rules: [],
    }),
    "w/TASKS.md": "- **KX-06** (S1): owns the gate.\n",
  });
  const run = (...args) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  const found = run("KX-06", "--root", root);
  assert.equal(found.status, 0);
  assert.equal(found.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(found.stdout).source, "process");
  assert.equal(run("KX-60", "--root", root).status, 1);
  assert.equal(run("--root", root).status, 2);
});

test("find-contract.mjs: an option without its value is a usage error", () => {
  const root = repo({ "TASKS.md": "- **KX-06** owns the gate.\n" });
  const run = (...args) => spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd: root });
  for (const args of [
    ["KX-06", "--root"],
    ["KX-06", "--root", "--kind", "task"],
    ["KX-06", "--kind"],
  ]) {
    const res = run(...args);
    assert.equal(res.status, 2, args.join(" "));
    assert.match(res.stderr, /^usage: find-contract\.mjs/);
  }
});

test("find-contract.mjs: an unknown option is a usage error; --flag=value reads as --flag value", () => {
  const root = repo({ "TASKS.md": "- **KX-06** owns the gate.\n" });
  const run = (...args) => spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd: root });
  for (const args of [
    ["KX-06", "--bogus"],
    ["--bogus", "KX-06"],
    ["KX-06", "--kind=task", "-x"],
  ]) {
    const res = run(...args);
    assert.equal(res.status, 2, args.join(" "));
    assert.match(res.stderr, /^unknown option "(--bogus|-x)"\nusage: find-contract\.mjs/);
  }
  const res = run("KX-06", `--root=${root}`, "--kind=task");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).file, "TASKS.md");
  assert.equal(run("KX-06", "--kind=").status, 2, "an empty value is no value");
});

test("find-contract.mjs: an invalid process file is reported on stderr, then the lookup falls back", () => {
  const root = repo({
    ".agentry/process.json": '{"version": 1, "name": "X"}',
    "docs/TASKS.md": "- **KX-06** owns the gate.\n",
  });
  const res = spawnSync("node", [CLI, "KX-06", "--root", root], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).source, "discovered");
  assert.match(res.stderr, /process\.json: not used \(the process file is missing "root"/);
});

test("find-contract.mjs: a broken workflow.json is reported under its own path, not the process file's", () => {
  const root = repo({
    ".agentry/process.json": JSON.stringify(BASE),
    ".agentry/workflow.json": "{ not json",
    "docs/TASKS.md": "- **KX-06** owns the gate.\n",
  });
  const res = spawnSync("node", [CLI, "KX-06", "--root", root], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).source, "discovered");
  assert.match(res.stderr, new RegExp(`^${join(root, ".agentry", "workflow.json")}: not used \\(`));
  assert.doesNotMatch(res.stderr, /process\.json/);
});

// One block for several tasks: every `**<id> · …**` lead before the first colon declares an id.
const SHARED = [
  "## Sprint S3",
  "",
  "**KX-11 · Shots** ⚑, **KX-12 · The shark**, **KX-13 · The bouncer** (S3a), **KX-14 · Week data** (S3d): owns `src/shots.mjs` · accept: **KX-15** is not declared here.",
  "  more of the shared body.",
  "",
  "**KX-16 · Alone** (S3): owns the lamp.",
].join("\n");

test("a shared block is found under every lead of its first sentence, as the same block", () => {
  const first = blocksIn(SHARED, "KX-11")[0];
  for (const id of ["KX-12", "KX-13", "KX-14"]) {
    const [hit] = blocksIn(SHARED, id);
    assert.equal(hit.line, 3, id);
    assert.equal(hit.block, first.block, id);
  }
  assert.doesNotMatch(first.block, /KX-16/);
});

test("a bold id after the first colon is not a lead of the shared block", () => {
  assert.deepEqual(blocksIn(SHARED, "KX-15"), []);
});

test("findContract finds a task that sits in a shared block, not only the first", () => {
  const root = repo({ "TASKS.md": SHARED });
  const spec = { root: ".", kinds: { task: { contract: { blocks: ["TASKS.md"] } } } };
  const hit = findContract({ root, spec, id: "KX-13" });
  assert.equal(hit.status, "found");
  assert.equal(hit.line, 3);
});

// A board whose sprint file links each task's contract: `[contract](path#anchor)` in its Tasks table.
const LINKED = {
  ".agentry/process.json": JSON.stringify({
    version: 1,
    name: "X",
    root: "w",
    kinds: {
      sprint: {
        label: "Sprint",
        at: { table: "BOARD.md", heading: "Sprints" },
        id: { column: "Sprint" },
        fields: { status: { column: "Status" } },
        file: {
          glob: "sprints/{id}_*.md",
          sections: { tasks: { heading: "Tasks", as: "table", column: "Task" } },
        },
      },
      task: {
        label: "Task",
        at: { table: "BOARD.md", heading: "Tasks" },
        id: { column: "Task" },
        fields: {
          sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
          status: { column: "Status" },
        },
        contract: { blocks: ["TASKS.md"], lead: ["bold"] },
      },
    },
    rules: [],
  }),
  "w/BOARD.md": [
    "## Sprints",
    "| Sprint | Status |",
    "| --- | --- |",
    "| S1 | doing |",
    "## Tasks",
    "| Task | Sprint | Status |",
    "| --- | --- | --- |",
    "| KX-41 | S1 | todo |",
    "| KX-42 | S1 | todo |",
    "",
  ].join("\n"),
  "w/sprints/S1_one.md": [
    "# S1",
    "## Tasks",
    "| Task | What | Contract |",
    "| --- | --- | --- |",
    "| KX-41 | Step mode | [contract](../../plans/LOOP.md#step-mode) |",
    "| KX-42 | Shots | [contract](../TASKS.md) |",
    "",
  ].join("\n"),
  "plans/LOOP.md": "**KX-41 · Step mode** · owns `step.mjs` · accept: it steps.\n",
  "w/TASKS.md": [
    "- **KX-42** (S1): owns `shots.mjs` · accept: one per key.",
    "- **KX-41 · Step mode, first cut** · owns `step0.mjs`.",
    "",
  ].join("\n"),
};
const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");
const board = (root, ...args) =>
  spawnSync("node", [BOARD, ...args, "--root", root], { encoding: "utf8" });

test("board contract follows the sprint row's contract link to a file outside the search set", () => {
  const root = repo(LINKED);
  const res = board(root, "contract", "KX-41", "--json");
  assert.equal(res.status, 0, res.stderr);
  const found = JSON.parse(res.stdout);
  assert.deepEqual(
    [found.status, found.file, found.line, found.source, found.related],
    ["found", "plans/LOOP.md", 1, "process", [{ file: "w/TASKS.md", line: 2 }]],
    "the link names one of two real contracts",
  );
  assert.equal(JSON.parse(board(root, "contract", "KX-42").stdout).file, "w/TASKS.md");
});

test("board contract takes the id in any case and answers with the board's id", () => {
  const found = JSON.parse(board(repo(LINKED), "contract", "kx-41").stdout);
  assert.deepEqual([found.status, found.id], ["found", "KX-41"]);
});

test("board contract's usage says it takes a task id", () => {
  const res = board(repo(LINKED), "contract");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^✗ board contract: needs an id → board contract --help/);
});

test("board contract --kind: a name only Object.prototype has, or no kind of the board, is a usage error", () => {
  const root = repo(LINKED);
  for (const kind of ["constructor", "toString", "nosuch"]) {
    const res = board(root, "contract", "KX-41", "--kind", kind);
    assert.equal(res.status, 2, `${kind}: ${res.stderr}`);
    assert.match(res.stderr, new RegExp(`unknown kind "${kind}" \\(kinds: sprint, task\\)`));
    assert.doesNotMatch(res.stderr, /TypeError/);
  }
  assert.equal(board(root, "contract", "KX-41", "--kind", "task").status, 0);
});

test("findContract looks the kind up as the board's own: a prototype name never throws", () => {
  const root = repo({ "TASKS.md": "- **KX-62** (S1): owns the stool.\n" });
  const spec = { root: ".", kinds: { task: { contract: { blocks: ["TASKS.md"] } } } };
  for (const kind of ["constructor", "__proto__", "hasOwnProperty"])
    assert.equal(findContract({ root, spec, id: "KX-62", kind }).status, "found", kind);
});

test("board explain's help example names the process file the run keeps", () => {
  const res = board(repo(LINKED), "explain", "--help");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /board explain --process \.agentry\/run\/process\/process\.json\n/);
});
