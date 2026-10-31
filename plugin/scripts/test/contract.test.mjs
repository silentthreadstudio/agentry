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

test("a bold start after a sentence opens a block that runs over whole lines", () => {
  const [hit] = blocksIn(BOLD, "KX-02a");
  assert.equal(hit.line, 6);
  assert.match(hit.block, /and its rope\./);
  assert.doesNotMatch(hit.block, /KX-03/);
});

test("a bold block ends at any heading; a heading block at one of its level", () => {
  assert.equal(blocksIn(BOLD, "KX-03")[0].block, "- **KX-03** (S2): owns the lamp.");
  const text = "## S1 · One\n### F7 · Door\n- **Owns:** a\n- **Accept:** b\n### F8 · Bell\nx";
  assert.equal(blocksIn(text, "F7")[0].block, "### F7 · Door\n- **Owns:** a\n- **Accept:** b");
  assert.deepEqual(blocksIn(text, "F7", ["bold"]), [], "lead limits which starts count");
});

test("the process file's blocks win; later hits are related", () => {
  const root = repo({
    "board/TASKS.md": "- **KX-05** (S1): the amended contract.\n",
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
      file: "board/TASKS.md",
      line: 1,
      source: "process",
      block: undefined,
      related: [{ file: "plans/OLD.md", line: 1 }],
    },
  );
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
