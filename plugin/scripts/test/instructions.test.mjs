// Tests for lib/process/instructions.mjs and `board instructions` (cli/instructions.mjs): the Agentry block
// upserted into AGENTS.md between its markers (no file, a file without the block, an older block, CRLF,
// broken markers), the `@AGENTS.md` import added to an existing CLAUDE.md (with and without it, never
// creating one), byte-idempotent re-runs, and the preview writing nothing.
// Run: node --test plugin/scripts/test/instructions.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../lib/process/cli/instructions.mjs";
import { TEMPLATE, locateBlock } from "../lib/process/instruction-files.mjs";
import {
  BEGIN,
  END,
  addImport,
  hasBlock,
  removeBlock,
  renderBlock,
  upsertBlock,
} from "../lib/process/instructions.mjs";
import { writeSpec } from "./spec-files.mjs";

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

test("the preview prints the block as + lines and writes nothing", () => {
  const root = repo({ "CLAUDE.md": "# C\n" });
  const { exit, out } = run([], { root, spec: SPEC });
  assert.equal(exit, 0);
  assert.match(out, /^AGENTS\.md: create it with the Agentry block$/m);
  assert.match(out, /^\+ <!-- agentry:begin v1 -->$/m);
  assert.match(out, /^\+ .*`docs\/CONDUCTOR\.md`/m);
  assert.match(out, /^CLAUDE\.md: add `@AGENTS\.md` as its first line$/m);
  assert.match(out, /preview: nothing written; add --apply to write it/);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(read(root, "CLAUDE.md"), "# C\n");
});

test("--apply creates AGENTS.md and imports it from CLAUDE.md; a second run changes nothing", () => {
  const root = repo({ "CLAUDE.md": "# C\n" });
  const first = run(["--apply"], { root, spec: SPEC });
  assert.equal(first.exit, 0);
  assert.match(first.out, /wrote AGENTS\.md, CLAUDE\.md/);
  const agents = read(root, "AGENTS.md");
  assert.ok(agents.startsWith(`${BEGIN}\n## Agentry\n`));
  assert.ok(agents.endsWith(`${END}\n`));
  assert.match(agents, /`docs\/CONDUCTOR\.md`/);
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n# C\n");
  const second = run(["--apply"], { root, spec: SPEC });
  assert.match(second.out, /up to date/);
  assert.match(second.out, /already imports AGENTS\.md/);
  assert.match(second.out, /nothing to write/);
  assert.equal(read(root, "AGENTS.md"), agents);
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n# C\n");
});

test("--apply never creates CLAUDE.md", () => {
  const root = repo();
  const { out } = run(["--apply"], { root, spec: SPEC });
  assert.match(out, /CLAUDE\.md: none \(not created/);
  assert.equal(existsSync(join(root, "CLAUDE.md")), false);
  assert.ok(existsSync(join(root, "AGENTS.md")));
});

test("an old block shows as - and + lines and only the block changes", () => {
  const before =
    "# A\r\n\r\n<!-- agentry:begin v0 -->\r\nold\r\n<!-- agentry:end -->\r\n\r\nmine\r\n";
  const root = repo({ "AGENTS.md": before });
  const { out } = run(["--apply"], { root, spec: SPEC });
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
  const { exit, out } = run(["--apply"], { root, spec: SPEC });
  assert.equal(exit, 2);
  assert.match(out, /nothing written/);
  assert.equal(read(root, "AGENTS.md"), `${BEGIN}\nhalf\n`);
  assert.equal(read(root, "CLAUDE.md"), "# C\n");
});

test("AGENTS.md as a symlink out of the repo, or a broken one, is refused", () => {
  const outside = repo({ "AGENTS.md": "elsewhere\n" });
  const root = repo();
  symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
  assert.match(run(["--apply"], { root, spec: SPEC }).out, /symlink out of the repository/);
  assert.equal(read(outside, "AGENTS.md"), "elsewhere\n");
  const dangling = repo();
  symlinkSync(join(outside, "gone.md"), join(dangling, "AGENTS.md"));
  const res = run(["--apply"], { root: dangling, spec: SPEC });
  assert.equal(res.exit, 2);
  assert.equal(existsSync(join(outside, "gone.md")), false);
});

test("a CLAUDE.md that links to AGENTS.md does not import itself", () => {
  const root = repo({ "AGENTS.md": "# Shared\n" });
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  const { out } = run(["--apply"], { root, spec: SPEC });
  assert.match(out, /the same file as AGENTS\.md/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /@AGENTS\.md/);
});

test("without conductor.prompt the block names no prompt and says so", () => {
  const root = repo();
  const { out } = run(["--apply"], { root, spec: {} });
  assert.match(out, /no conductor\.prompt/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /\{prompt\}|conductor prompt is/);
});

test("`board instructions` routes through the CLI on a real process file", () => {
  const root = scratch();
  cpSync(join(HERE, "fixtures", "table-board", "docs"), join(root, "docs"), { recursive: true });
  const fixture = (name) =>
    JSON.parse(readFileSync(join(HERE, "fixtures", "table-board", name), "utf8"));
  const proc = writeSpec(root, { ...fixture("process.json"), ...fixture("workflow.json") });
  const res = spawnSync(
    process.execPath,
    [BOARD, "instructions", "--apply", "--root", root, "--process", proc],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /wrote AGENTS\.md/);
  assert.ok(read(root, "AGENTS.md").includes("/agentry:exec <id>"));
});

// notes round: fences, comments, BOM, replacer, read-only files, .claude/CLAUDE.md

test("markers inside a code fence are not the block: the block is appended, the example untouched", () => {
  const fenced = `# Docs\n\n\`\`\`md\n${BLOCK}\n\`\`\`\n`;
  const { text, action } = upsertBlock(fenced, BLOCK);
  assert.equal(action, "append");
  assert.equal(text, `${fenced}\n${BLOCK}\n`);
  assert.equal(upsertBlock(text, BLOCK).action, "unchanged");
  const tilde = `~~~\n${BEGIN}\n~~~\n`;
  assert.equal(upsertBlock(tilde, BLOCK).action, "append");
});

test("a real block beside a fenced example is the one replaced", () => {
  const fenced = `\`\`\`\n${BEGIN}\n\`\`\`\n\n`;
  const old = "<!-- agentry:begin v0 -->\nold\n<!-- agentry:end -->";
  const { text, action } = upsertBlock(fenced + old, BLOCK);
  assert.equal(action, "replace");
  assert.equal(text, fenced + BLOCK);
});

test("a byte-order mark before the block on line 1 does not hide it", () => {
  const old = "﻿<!-- agentry:begin v0 -->\nold\n<!-- agentry:end -->\n";
  const { text, action } = upsertBlock(old, BLOCK);
  assert.equal(action, "replace");
  assert.equal(text, `﻿${BLOCK}\n`);
  assert.equal(upsertBlock(text, BLOCK).action, "unchanged");
});

test("renderBlock keeps `$&` and `$1` in the prompt path literal", () => {
  const block = renderBlock("- read {prompt} and {prompt}\n", { prompt: "docs/$&-$1.md" });
  assert.match(block, /read docs\/\$&-\$1\.md and docs\/\$&-\$1\.md/);
});

test("an import in a fence, an HTML comment or a code span is not an import", () => {
  for (const text of [
    "# C\n```\n@AGENTS.md\n```\n",
    "# C\n<!-- @AGENTS.md -->\n",
    "# C\n<!--\n@AGENTS.md\n-->\n",
    "# C\nadd `@AGENTS.md` here\n",
  ]) {
    const res = addImport(text);
    assert.equal(res.action, "import", text);
    assert.ok(res.text.startsWith("@AGENTS.md\n"));
  }
});

test("addImport takes the `.claude/` form and recognises it", () => {
  assert.equal(addImport("# C\n", "@../AGENTS.md").text, "@../AGENTS.md\n# C\n");
  for (const text of ["@../AGENTS.md\n# C\n", "# C\n@./../AGENTS.md\n"])
    assert.equal(addImport(text, "@../AGENTS.md").action, "has-import", text);
  assert.equal(addImport("@AGENTS.md\n", "@../AGENTS.md").action, "import");
  assert.equal(addImport("﻿# C\r\n", "@../AGENTS.md").text, "﻿@../AGENTS.md\r\n# C\r\n");
});

test("project instructions in .claude/CLAUDE.md get `@../AGENTS.md`, and a re-run changes nothing", () => {
  const root = repo();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "CLAUDE.md"), "# C\n");
  const first = run(["--apply"], { root, spec: SPEC });
  assert.match(first.out, /^\.claude\/CLAUDE\.md: add `@\.\.\/AGENTS\.md` as its first line$/m);
  assert.equal(read(root, ".claude/CLAUDE.md"), "@../AGENTS.md\n# C\n");
  assert.equal(existsSync(join(root, "CLAUDE.md")), false);
  const second = run(["--apply"], { root, spec: SPEC });
  assert.match(second.out, /\.claude\/CLAUDE\.md: already imports/);
  assert.equal(read(root, ".claude/CLAUDE.md"), "@../AGENTS.md\n# C\n");
});

test("with both CLAUDE.md files, only the root one gets the import", () => {
  const root = repo({ "CLAUDE.md": "# R\n" });
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "CLAUDE.md"), "# D\n");
  run(["--apply"], { root, spec: SPEC });
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n# R\n");
  assert.equal(read(root, ".claude/CLAUDE.md"), "# D\n");
});

test("a read-only CLAUDE.md is exit 2 and AGENTS.md is not written either", () => {
  const root = repo({ "CLAUDE.md": "# C\n" });
  chmodSync(join(root, "CLAUDE.md"), 0o444);
  const res = run(["--apply"], { root, spec: SPEC });
  assert.equal(res.exit, 2);
  assert.match(res.out, /nothing written/);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(read(root, "CLAUDE.md"), "# C\n");
  assert.deepEqual(readdirSync(root).sort(), ["CLAUDE.md"]);
});

// removeBlock / hasBlock

test("removeBlock is the exact inverse of an append, for every starting state", () => {
  for (const start of [
    "",
    "# Agents\n",
    "a\n\nb\n",
    "a\r\nb\r\n",
    "\n",
    "\uFEFF# A\r\n",
    "\uFEFF",
  ]) {
    const added = upsertBlock(start, BLOCK).text;
    const res = removeBlock(added);
    assert.equal(res.action, "remove", JSON.stringify(start));
    assert.equal(res.text, start, JSON.stringify(start));
    assert.equal(res.old, BLOCK.split("\n").join(added.includes("\r\n") ? "\r\n" : "\n"));
  }
});

test("removeBlock keeps every byte outside the marker range, a block in the middle too", () => {
  const head = "# A\r\nmine\r\n";
  const tail = "\r\nafter  \r\n";
  const text = `${head}\r\n${BLOCK.split("\n").join("\r\n")}\r\n${tail}`;
  assert.equal(removeBlock(text).text, `${head}${tail}`);
  assert.equal(removeBlock(`x\n${BLOCK}\n`).text, "x\n", "no blank line before it: none taken");
});

test("removeBlock: no block is none, broken markers an error, a fenced example untouched", () => {
  assert.deepEqual(removeBlock("# A\n"), { text: "# A\n", action: "none", old: null });
  assert.match(removeBlock(`${BEGIN}\nhalf\n`).error, /fix them by hand/);
  const fenced = `\`\`\`\n${BLOCK}\n\`\`\`\n`;
  assert.equal(removeBlock(fenced).action, "none");
});

test("hasBlock sees a marker outside a fence only", () => {
  assert.equal(hasBlock(`x\n${BLOCK}\n`), true);
  assert.equal(hasBlock(`\uFEFF${BLOCK}\n`), true);
  assert.equal(hasBlock(`${BEGIN}\n`), true);
  assert.equal(hasBlock(`\`\`\`\n${BLOCK}\n\`\`\`\n`), false);
  assert.equal(hasBlock("# A\n"), false);
});

// locateBlock

test("locateBlock names the file that holds the block, once", () => {
  const none = locateBlock(repo({ "AGENTS.md": "# A\n" }));
  assert.equal(none.at, null);
  assert.equal(none.files["AGENTS.md"].text, "# A\n");
  assert.equal(none.files["CLAUDE.local.md"].text, null);
  assert.equal(locateBlock(repo({ "AGENTS.md": `${BLOCK}\n` })).at, "AGENTS.md");
  assert.equal(locateBlock(repo({ "CLAUDE.local.md": `${BLOCK}\n` })).at, "CLAUDE.local.md");
  assert.equal(locateBlock(repo()).at, null);
});

test("locateBlock: a block in both files is an error; a link between them is one file", () => {
  const both = locateBlock(repo({ "AGENTS.md": `${BLOCK}\n`, "CLAUDE.local.md": `${BLOCK}\n` }));
  assert.match(both.error, /^AGENTS\.md and CLAUDE\.local\.md both hold an Agentry block/);
  const root = repo({ "AGENTS.md": `${BLOCK}\n` });
  symlinkSync("AGENTS.md", join(root, "CLAUDE.local.md"));
  const one = locateBlock(root);
  assert.equal(one.at, "AGENTS.md");
  assert.deepEqual(Object.keys(one.files), ["AGENTS.md"]);
});

test("locateBlock refuses a CLAUDE.local.md that links out of the repo", () => {
  const outside = repo({ "x.md": "elsewhere\n" });
  const root = repo();
  symlinkSync(join(outside, "x.md"), join(root, "CLAUDE.local.md"));
  assert.match(locateBlock(root).error, /CLAUDE\.local\.md is a symlink out of the repository/);
});

// board instructions --target

const snapshot = (root) =>
  readdirSync(root, { recursive: true })
    .sort()
    .map((name) => {
      const st = statSync(join(root, name));
      return [name, st.isFile() ? readFileSync(join(root, name)).toString("hex") : "", st.mtimeMs];
    });
const go = (root, ...argv) => run(argv, { root, spec: SPEC });
// The block as `board instructions` renders it for SPEC, then a line end.
const blockFile = () =>
  `${renderBlock(readFileSync(TEMPLATE, "utf8"), { prompt: SPEC.conductor.prompt })}\n`;

test("--target local --apply creates CLAUDE.local.md, touches nothing else, and a re-run writes nothing", () => {
  const root = repo({ "CLAUDE.md": "# C\n", "AGENTS.md": "# A\n" });
  const first = go(root, "--target", "local", "--apply");
  assert.equal(first.exit, 0, first.out);
  assert.match(first.out, /^CLAUDE\.local\.md: create it with the Agentry block$/m);
  assert.match(first.out, /^CLAUDE\.md: no import needed \(the block is in CLAUDE\.local\.md\)$/m);
  assert.match(first.out, /wrote CLAUDE\.local\.md$/m);
  assert.equal(read(root, "CLAUDE.local.md"), blockFile());
  assert.equal(read(root, "CLAUDE.md"), "# C\n");
  assert.equal(read(root, "AGENTS.md"), "# A\n");
  const before = snapshot(root);
  const again = go(root, "--target", "local", "--apply");
  assert.match(again.out, /^CLAUDE\.local\.md: the Agentry block is up to date$/m);
  assert.match(again.out, /nothing to write/);
  assert.deepEqual(snapshot(root), before);
});

test("--target local moves a block out of AGENTS.md and --target agents puts every byte back", () => {
  const mine = "\uFEFF# Agents\r\n\r\nHouse rules.  \r\n";
  const root = repo();
  writeFileSync(join(root, "AGENTS.md"), mine);
  go(root, "--target", "agents", "--apply");
  const original = read(root, "AGENTS.md");
  assert.ok(original.startsWith(`${mine}\r\n${BEGIN}\r\n`));
  const toLocal = go(root, "--target", "local", "--apply");
  assert.match(
    toLocal.out,
    /^AGENTS\.md: remove the Agentry block \(it moves to CLAUDE\.local\.md\)$/m,
  );
  assert.equal(read(root, "AGENTS.md"), mine);
  assert.equal(read(root, "CLAUDE.local.md"), blockFile());
  const back = go(root, "--target", "agents", "--apply");
  assert.match(
    back.out,
    /^CLAUDE\.local\.md: remove the Agentry block \(it moves to AGENTS\.md\)$/m,
  );
  assert.equal(read(root, "AGENTS.md"), original);
  assert.equal(read(root, "CLAUDE.local.md"), "");
});

test("a file that held only the block is left empty, never deleted", () => {
  const root = repo();
  go(root, "--apply");
  go(root, "--target", "local", "--apply");
  assert.equal(existsSync(join(root, "AGENTS.md")), true);
  assert.equal(read(root, "AGENTS.md"), "");
});

test("the removal is written first, so a stop between the writes leaves no block anywhere", () => {
  const root = repo({ "AGENTS.md": `# A\n\n${BLOCK}\n` });
  const res = go(root, "--target", "local", "--apply", "--json");
  const data = JSON.parse(res.out);
  assert.deepEqual(data.files, ["AGENTS.md", "CLAUDE.local.md"]);
  assert.deepEqual([data.target, data.agents, data.local], ["local", "remove", "create"]);
  // That stopped state: the removal in place, the target not written. The same command finishes it.
  const stopped = repo({ "AGENTS.md": "# A\n" });
  assert.equal(locateBlock(stopped).at, null);
  const rerun = go(stopped, "--target", "local", "--apply");
  assert.equal(rerun.exit, 0);
  assert.equal(locateBlock(stopped).at, "CLAUDE.local.md");
  assert.equal(read(stopped, "AGENTS.md"), "# A\n");
});

test("without --target the block stays where it is, and goes to AGENTS.md when it is nowhere", () => {
  const root = repo({ "CLAUDE.local.md": `${BLOCK.replace("first", "eventually")}\n` });
  const res = go(root, "--apply");
  assert.match(res.out, /^CLAUDE\.local\.md: replace the Agentry block$/m);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(locateBlock(root).at, "CLAUDE.local.md");
  const nowhere = repo({ "CLAUDE.local.md": "# mine\n" });
  go(nowhere, "--apply");
  assert.equal(locateBlock(nowhere).at, "AGENTS.md");
  assert.equal(read(nowhere, "CLAUDE.local.md"), "# mine\n");
});

test("a block in both files is exit 2 and nothing is written", () => {
  const root = repo({ "AGENTS.md": `${BLOCK}\n`, "CLAUDE.local.md": `${BLOCK}\n` });
  const before = snapshot(root);
  const res = go(root, "--target", "local", "--apply");
  assert.equal(res.exit, 2);
  assert.equal(
    res.out,
    "✗ board instructions: AGENTS.md and CLAUDE.local.md both hold an Agentry block; remove one by hand; nothing written",
  );
  assert.deepEqual(snapshot(root), before);
});

test("the import in CLAUDE.md is left, with a note, after a move to local", () => {
  const root = repo({ "AGENTS.md": `# A\n\n${BLOCK}\n`, "CLAUDE.md": "@AGENTS.md\n# C\n" });
  const { out } = go(root, "--target", "local", "--apply");
  assert.match(
    out,
    /^note: CLAUDE\.md still imports AGENTS\.md; drop the import by hand if AGENTS\.md held only the block$/m,
  );
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n# C\n");
  const json = JSON.parse(go(root, "--target", "local", "--json").out);
  assert.equal(json.claude.action, "not-needed");
});

test("refusals are exit 2 with every file byte- and mtime-identical", () => {
  const outside = repo({ "x.md": "elsewhere\n" });
  const root = repo({ "AGENTS.md": `# A\n\n${BLOCK}\n`, "CLAUDE.md": "# C\n" });
  const before = snapshot(root);
  for (const argv of [
    ["--lint", "--apply"],
    ["--lint", "--target", "local"],
    ["--target", "LOCAL", "--apply"],
    ["--target", "nope", "--apply"],
    ["--target"],
    ["--target", "local", "--target", "agents"],
  ])
    assert.equal(go(root, ...argv).exit, 2, argv.join(" "));
  assert.deepEqual(snapshot(root), before);
  const linked = repo({ "AGENTS.md": "# A\n" });
  symlinkSync(join(outside, "x.md"), join(linked, "CLAUDE.local.md"));
  const kept = snapshot(linked);
  const res = go(linked, "--target", "local", "--apply");
  assert.equal(res.exit, 2);
  assert.match(res.out, /CLAUDE\.local\.md is a symlink out of the repository/);
  assert.deepEqual(snapshot(linked), kept);
  assert.equal(read(outside, "x.md"), "elsewhere\n");
});

test("--target local with a CLAUDE.local.md that links to AGENTS.md writes the one file", () => {
  const root = repo({ "AGENTS.md": "# A\n" });
  symlinkSync("AGENTS.md", join(root, "CLAUDE.local.md"));
  const res = go(root, "--target", "local", "--apply");
  assert.equal(res.exit, 0, res.out);
  assert.equal(read(root, "AGENTS.md"), `# A\n\n${blockFile()}`);
});

test("a file that is not UTF-8 is never rewritten: exit 2, every file identical", () => {
  const odd = Buffer.concat([Buffer.from("# A \n"), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]);
  for (const [files, argv] of [
    [{}, ["--apply"]],
    [{ "CLAUDE.local.md": `${BLOCK}\n` }, ["--target", "agents", "--apply"]],
  ]) {
    const root = repo(files);
    writeFileSync(join(root, "AGENTS.md"), odd);
    const before = snapshot(root);
    const res = go(root, ...argv);
    assert.equal(res.exit, 2, argv.join(" "));
    assert.match(res.out, /AGENTS\.md is not UTF-8 text; nothing written/);
    assert.deepEqual(snapshot(root), before);
  }
  const holder = repo();
  writeFileSync(join(holder, "AGENTS.md"), Buffer.concat([odd, Buffer.from(`${BLOCK}\n`)]));
  const moved = go(holder, "--target", "local", "--apply");
  assert.equal(moved.exit, 2);
  assert.match(moved.out, /AGENTS\.md is not UTF-8 text; nothing written/);
  assert.equal(existsSync(join(holder, "CLAUDE.local.md")), false);
});

// git notes on a block in CLAUDE.local.md

function gitRepo(files = {}) {
  const root = repo(files);
  execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}
// A developer's own global ignore file must not decide these.
function cleanGit(body) {
  const keep = { ...process.env };
  process.env.XDG_CONFIG_HOME = scratch();
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    body();
  } finally {
    for (const k of ["XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"])
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
  }
}
const IGNORE_NOTE =
  "note: git does not ignore CLAUDE.local.md → echo CLAUDE.local.md >> .gitignore";
const TRACKED_NOTE = "note: CLAUDE.local.md is tracked by git; the block would be committed";

test("a block going to CLAUDE.local.md that git does not ignore gets the .gitignore note", () =>
  cleanGit(() => {
    const root = gitRepo();
    const { out } = go(root, "--target", "local");
    assert.ok(out.split("\n").includes(IGNORE_NOTE), out);
    assert.ok(!out.includes("is tracked by git"));
    writeFileSync(join(root, ".gitignore"), "CLAUDE.local.md\n");
    assert.doesNotMatch(
      go(root, "--target", "local").out,
      /^note: (git does not|CLAUDE\.local\.md is tracked)/m,
    );
  }));

test("a tracked CLAUDE.local.md gets the tracked note, even when it is also ignored", () =>
  cleanGit(() => {
    const root = gitRepo({ "CLAUDE.local.md": "# mine\n", ".gitignore": "CLAUDE.local.md\n" });
    execFileSync("git", ["-C", root, "add", "-f", "CLAUDE.local.md"]);
    const { out } = go(root, "--target", "local");
    assert.ok(out.split("\n").includes(TRACKED_NOTE), out);
    assert.ok(!out.includes("does not ignore"));
  }));

test("the note also shows when the block is found in CLAUDE.local.md, and for no other target", () =>
  cleanGit(() => {
    const root = gitRepo({ "CLAUDE.local.md": `${BLOCK}\n` });
    assert.ok(go(root).out.split("\n").includes(IGNORE_NOTE));
    assert.ok(!go(root, "--target", "agents").out.includes("does not ignore"));
  }));

test("outside a git work tree no git note prints and nothing fails", () =>
  cleanGit(() => {
    const root = repo();
    const res = go(root, "--target", "local", "--apply");
    assert.equal(res.exit, 0, res.out);
    assert.doesNotMatch(res.out, /note: (git|CLAUDE\.local\.md is tracked)/);
  }));

test("the lint is reached through --lint only: instructions-lint is no subcommand", () => {
  const res = spawnSync("node", [BOARD, "instructions-lint", "--root", scratch()], {
    encoding: "utf8",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /instructions-lint/);
});
