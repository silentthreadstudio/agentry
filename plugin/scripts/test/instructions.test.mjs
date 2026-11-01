// Tests for lib/process/instructions.mjs and `board instructions` (cli/instructions.mjs): the Agentry block
// upserted into AGENTS.md between its markers (no file, a file without the block, an older block, CRLF,
// broken markers), the `@AGENTS.md` import added to an existing CLAUDE.md (with and without it, never
// creating one), byte-idempotent re-runs, and the dry run writing nothing.
// Run: node --test plugin/scripts/test/instructions.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../lib/process/cli/instructions.mjs";
import { BEGIN, END, addImport, renderBlock, upsertBlock } from "../lib/process/instructions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, "..", "board.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentry-instr-")));
  temps.push(dir);
  return dir;
};

const BLOCK = renderBlock("## Agentry\n\n- Read `{prompt}` first.\n- Run `/agentry:start`.\n", {
  prompt: "docs/CONDUCTOR.md",
});
const SPEC = { conductor: { prompt: "docs/CONDUCTOR.md" } };

/** A repo root holding the given files ({ name: text }). */
function repo(files = {}) {
  const root = scratch();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}
const read = (root, name) => readFileSync(join(root, name), "utf8");

// renderBlock

test("renderBlock wraps the template in the v1 markers and fills the conductor prompt", () => {
  assert.equal(
    BLOCK,
    `${BEGIN}\n## Agentry\n\n- Read \`docs/CONDUCTOR.md\` first.\n- Run \`/agentry:start\`.\n${END}`,
  );
  assert.equal(BEGIN, "<!-- agentry:begin v1 -->");
  assert.equal(END, "<!-- agentry:end -->");
});

test("renderBlock leaves out the lines naming the prompt when there is none", () => {
  const block = renderBlock("- one\n- read {prompt}\n- two\n", {});
  assert.equal(block, `${BEGIN}\n- one\n- two\n${END}`);
});

// upsertBlock

test("no AGENTS.md: the file is the block alone", () => {
  assert.deepEqual(upsertBlock(null, BLOCK), { text: `${BLOCK}\n`, action: "create", old: null });
});

test("a file without the block keeps every byte and gets the block after a blank line", () => {
  const before = "# Agents\n\nHouse rules.\n";
  const { text, action } = upsertBlock(before, BLOCK);
  assert.equal(action, "append");
  assert.equal(text, `${before}\n${BLOCK}\n`);
});

test("a file with no final line end gets one before the gap", () => {
  assert.equal(upsertBlock("# Agents", BLOCK).text, `# Agents\n\n${BLOCK}\n`);
});

test("an empty file gets the block with no leading gap", () => {
  assert.equal(upsertBlock("", BLOCK).text, `${BLOCK}\n`);
});

test("an older block is replaced in place; the text around it is untouched", () => {
  const head = "# Agents\n\nBefore.\n\n";
  const tail = "\n\nAfter, with trailing spaces   \n";
  const old = "<!-- agentry:begin v0 -->\nold line\n<!-- agentry:end -->";
  const { text, action, old: was } = upsertBlock(head + old + tail, BLOCK);
  assert.equal(action, "replace");
  assert.equal(was, old);
  assert.equal(text, head + BLOCK + tail);
});

test("a hand-edited v1 block is put back to the template", () => {
  const edited = BLOCK.replace("first", "eventually");
  const { text, action } = upsertBlock(`x\n\n${edited}\n`, BLOCK);
  assert.equal(action, "replace");
  assert.equal(text, `x\n\n${BLOCK}\n`);
});

test("re-running is byte-idempotent, for every starting state", () => {
  for (const start of [null, "", "# Agents", "a\n\nb\n", "a\r\nb\r\n"]) {
    const once = upsertBlock(start, BLOCK).text;
    const twice = upsertBlock(once, BLOCK);
    assert.equal(twice.action, "unchanged", JSON.stringify(start));
    assert.equal(twice.text, once);
  }
});

test("a CRLF file keeps CRLF, in the block too", () => {
  const before = "# Agents\r\n\r\nRules.\r\n";
  const { text } = upsertBlock(before, BLOCK);
  assert.equal(text, `${before}\r\n${BLOCK.split("\n").join("\r\n")}\r\n`);
  assert.doesNotMatch(text.replaceAll("\r\n", ""), /\n/);
  const old = `${before}<!-- agentry:begin v0 -->\r\nold\r\n<!-- agentry:end -->\r\ntail\r\n`;
  const replaced = upsertBlock(old, BLOCK).text;
  assert.equal(replaced, `${before}${BLOCK.split("\n").join("\r\n")}\r\ntail\r\n`);
});

test("markers that don't make one block are refused", () => {
  const cases = [
    `${BEGIN}\nno end\n`,
    `no begin\n${END}\n`,
    `${END}\n${BEGIN}\n`,
    `${BLOCK}\n\n${BLOCK}\n`,
  ];
  for (const text of cases) assert.match(upsertBlock(text, BLOCK).error, /fix them by hand/, text);
});

test("a marker that is not alone on its line is not a marker", () => {
  const before = `Mentions ${BEGIN} inline.\n`;
  assert.equal(upsertBlock(before, BLOCK).action, "append");
});

// addImport

test("CLAUDE.md without the import gets `@AGENTS.md` as its first line", () => {
  assert.deepEqual(addImport("# Claude\n\nRules.\n"), {
    text: "@AGENTS.md\n# Claude\n\nRules.\n",
    action: "import",
  });
});

test("CLAUDE.md that already imports AGENTS.md is left as it is", () => {
  for (const text of ["@AGENTS.md\n# C\n", "# C\n\nSee @AGENTS.md here.\n", "# C\n@./AGENTS.md\n"])
    assert.deepEqual(addImport(text), { text, action: "has-import" }, text);
});

test("a look-alike is not the import", () => {
  assert.equal(addImport("# C\n@AGENTS.md.bak\nmail@AGENTS.md\n").action, "import");
});

test("the import keeps CRLF and goes after a byte-order mark", () => {
  assert.equal(addImport("# C\r\n").text, "@AGENTS.md\r\n# C\r\n");
  assert.equal(addImport("﻿# C\n").text, "﻿@AGENTS.md\n# C\n");
});

// board instructions (the CLI)

test("the dry run prints the block as + lines and writes nothing", () => {
  const root = repo({ "CLAUDE.md": "# C\n" });
  const { exit, out } = run([], { root, spec: SPEC });
  assert.equal(exit, 0);
  assert.match(out, /^AGENTS\.md: create it with the Agentry block$/m);
  assert.match(out, /^\+ <!-- agentry:begin v1 -->$/m);
  assert.match(out, /^\+ .*`docs\/CONDUCTOR\.md`/m);
  assert.match(out, /^CLAUDE\.md: add `@AGENTS\.md` as its first line$/m);
  assert.match(out, /dry run: nothing written/);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(read(root, "CLAUDE.md"), "# C\n");
});

test("--write creates AGENTS.md and imports it from CLAUDE.md; a second run changes nothing", () => {
  const root = repo({ "CLAUDE.md": "# C\n" });
  const first = run(["--write"], { root, spec: SPEC });
  assert.equal(first.exit, 0);
  assert.match(first.out, /wrote AGENTS\.md, CLAUDE\.md/);
  const agents = read(root, "AGENTS.md");
  assert.ok(agents.startsWith(`${BEGIN}\n## Agentry\n`));
  assert.ok(agents.endsWith(`${END}\n`));
  assert.match(agents, /`docs\/CONDUCTOR\.md`/);
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n# C\n");
  const second = run(["--write"], { root, spec: SPEC });
  assert.match(second.out, /up to date/);
  assert.match(second.out, /already imports AGENTS\.md/);
  assert.match(second.out, /nothing to write/);
  assert.equal(read(root, "AGENTS.md"), agents);
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n# C\n");
});

test("--write never creates CLAUDE.md", () => {
  const root = repo();
  const { out } = run(["--write"], { root, spec: SPEC });
  assert.match(out, /CLAUDE\.md: none \(not created/);
  assert.equal(existsSync(join(root, "CLAUDE.md")), false);
  assert.ok(existsSync(join(root, "AGENTS.md")));
});

test("an old block shows as - and + lines and only the block changes", () => {
  const before =
    "# A\r\n\r\n<!-- agentry:begin v0 -->\r\nold\r\n<!-- agentry:end -->\r\n\r\nmine\r\n";
  const root = repo({ "AGENTS.md": before });
  const { out } = run(["--write"], { root, spec: SPEC });
  assert.match(out, /^AGENTS\.md: replace the Agentry block$/m);
  assert.match(out, /^- old$/m);
  assert.match(out, /^\+ <!-- agentry:begin v1 -->$/m);
  const after = read(root, "AGENTS.md");
  assert.ok(after.startsWith("# A\r\n\r\n<!-- agentry:begin v1 -->\r\n"));
  assert.ok(after.endsWith("<!-- agentry:end -->\r\n\r\nmine\r\n"));
  assert.doesNotMatch(after.replaceAll("\r\n", ""), /\n/);
});

test("broken markers are exit 2 and nothing is written", () => {
  const root = repo({ "AGENTS.md": `${BEGIN}\nhalf\n`, "CLAUDE.md": "# C\n" });
  const { exit, out } = run(["--write"], { root, spec: SPEC });
  assert.equal(exit, 2);
  assert.match(out, /nothing written/);
  assert.equal(read(root, "AGENTS.md"), `${BEGIN}\nhalf\n`);
  assert.equal(read(root, "CLAUDE.md"), "# C\n");
});

test("AGENTS.md as a symlink out of the repo, or a broken one, is refused", () => {
  const outside = repo({ "AGENTS.md": "elsewhere\n" });
  const root = repo();
  symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
  assert.match(run(["--write"], { root, spec: SPEC }).out, /symlink out of the repository/);
  assert.equal(read(outside, "AGENTS.md"), "elsewhere\n");
  const dangling = repo();
  symlinkSync(join(outside, "gone.md"), join(dangling, "AGENTS.md"));
  const res = run(["--write"], { root: dangling, spec: SPEC });
  assert.equal(res.exit, 2);
  assert.equal(existsSync(join(outside, "gone.md")), false);
});

test("a CLAUDE.md that links to AGENTS.md does not import itself", () => {
  const root = repo({ "AGENTS.md": "# Shared\n" });
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  const { out } = run(["--write"], { root, spec: SPEC });
  assert.match(out, /the same file as AGENTS\.md/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /@AGENTS\.md/);
});

test("without conductor.prompt the block names no prompt and says so", () => {
  const root = repo();
  const { out } = run(["--write"], { root, spec: {} });
  assert.match(out, /no conductor\.prompt/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /\{prompt\}|conductor prompt is/);
});

test("`board instructions` routes through the CLI on a real process file", () => {
  const root = scratch();
  cpSync(join(HERE, "fixtures", "table-board", "docs"), join(root, "docs"), { recursive: true });
  const proc = join(root, "process.json");
  cpSync(join(HERE, "fixtures", "table-board", "process.json"), proc);
  const res = spawnSync(
    process.execPath,
    [BOARD, "instructions", "--write", "--root", root, "--process", proc],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /wrote AGENTS\.md/);
  assert.ok(read(root, "AGENTS.md").includes("/agentry:exec <id>"));
});
