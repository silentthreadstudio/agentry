// Tests for lib/process/instruction-lint.mjs (the four rules on text) and `board instructions --lint`
// (cli/instructions-lint.mjs: which files are read, how a finding prints, what never changes).
// Run: node --test plugin/scripts/test/instruction-lint.test.mjs
import assert from "node:assert/strict";
import {
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
import { TEMPLATE } from "../lib/process/instruction-files.mjs";
import { RULES, lintText } from "../lib/process/instruction-lint.mjs";
import { renderBlock } from "../lib/process/instructions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "..", "..", "skills", "process", "templates");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentry-lint-")));
  temps.push(dir);
  return dir;
};
function repo(files = {}) {
  const root = scratch();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const rulesOf = (text, gateWords) => lintText("F.md", text, { gateWords }).map((f) => f.rule);

const GATE = ["tools/x/gate.sh"];
// Per rule: a line that fires, and near misses that name the Agentry command already.
const CASES = {
  "go-for-tasks": {
    fires: "Every task goes through `/agentry:go`.",
    excused: "Every task goes through `/agentry:exec <id>`, never `/agentry:go`.",
  },
  "session-routine": {
    fires: "Start every session by reading the notes.",
    excused: "Start every session with `/agentry:start`.",
  },
  "land-by-hand": {
    fires: "Run `git merge --no-ff` when the review is done.",
    excused: "Run `/agentry:merge T-1`, not `git merge --no-ff`.",
  },
  "gate-by-hand": {
    fires: "Run tools/x/gate.sh before every commit.",
    excused: "Run tools/x/gate.sh before every commit, or let `/agentry:exec` do it.",
  },
};

test("RULES are the four rules, in order", () => {
  assert.deepEqual(
    RULES.map((r) => r.rule),
    ["go-for-tasks", "session-routine", "land-by-hand", "gate-by-hand"],
  );
});

for (const [rule, { fires, excused }] of Object.entries(CASES)) {
  test(`${rule} fires on its line, with the replacement`, () => {
    const [f, ...rest] = lintText("F.md", `# T\n\n${fires}\n`, { gateWords: GATE });
    assert.equal(rest.length, 0);
    assert.deepEqual([f.file, f.line, f.rule, f.text], ["F.md", 3, rule, fires]);
    assert.ok(f.suggest.length > 0);
  });

  test(`${rule} is quiet when the line names the command, or sits in a fence, a comment or the block`, () => {
    assert.deepEqual(rulesOf(excused, GATE), [], "names the command");
    const hidden = [
      `\`\`\`\n${fires}\n\`\`\`\n`,
      `~~~md\n${fires}\n~~~\n`,
      `<!-- ${fires} -->\n`,
      `<!--\n${fires}\n-->\n`,
      `<!-- agentry:begin v1 -->\n${fires}\n<!-- agentry:end -->\n`,
      `<!-- agentry:begin v1 -->\n\`\`\`\n<!-- agentry:end -->\n${fires}\n\`\`\`\n`,
    ];
    for (const text of hidden) assert.deepEqual(rulesOf(text, GATE), [], text);
  });
}

test("the suggestions are the pinned sentences", () => {
  const sug = (line) => lintText("F.md", line, { gateWords: ["make check"] })[0].suggest;
  assert.equal(
    sug(CASES["go-for-tasks"].fires),
    "A task with a board id goes through `/agentry:exec <id>`; `/agentry:go` is for work with no board id.",
  );
  assert.equal(
    sug(CASES["session-routine"].fires),
    "Every session starts with `/agentry:start` and ends with `/agentry:close`.",
  );
  assert.equal(
    sug(CASES["land-by-hand"].fires),
    "Landing a task's branch goes through `/agentry:merge <id>`; the repo's own landing checks go in a skill named in `extensions.merge.checks`.",
  );
  assert.equal(
    sug("Always run make check."),
    "`/agentry:exec` and `/agentry:merge` run the gate (`make check`); run it by hand only for a change made outside them.",
  );
});

test("whole words: subtasks and /agentry:goal are not /agentry:go with a task", () => {
  assert.deepEqual(rulesOf("Split `/agentry:go` work into subtasks."), []);
  assert.deepEqual(rulesOf("`/agentry:goal` tracks a task."), []);
  assert.deepEqual(rulesOf("`/agentry:go` for each task."), ["go-for-tasks"]);
});

test("case does not matter", () => {
  assert.deepEqual(rulesOf("/AGENTRY:GO … Tasks"), ["go-for-tasks"]);
  assert.deepEqual(rulesOf("START EVERY SESSION with coffee"), ["session-routine"]);
});

test("session-routine covers its three shapes", () => {
  for (const line of [
    "Begin each working session with the board.",
    "Keep it green at the end of every session.",
    "Every session ends with a note.",
  ])
    assert.deepEqual(rulesOf(line), ["session-routine"], line);
  assert.deepEqual(rulesOf("A session is a unit of work."), []);
});

test("land-by-hand: merge it into main fires, merge into mainline does not", () => {
  assert.deepEqual(rulesOf("Then merge it into main."), ["land-by-hand"]);
  assert.deepEqual(rulesOf("Then merge the branch to master."), ["land-by-hand"]);
  assert.deepEqual(rulesOf("Then merge into mainline."), []);
  assert.deepEqual(rulesOf("Use `gh pr merge 4` or git cherry-pick."), ["land-by-hand"]);
  assert.deepEqual(rulesOf("Find it with git merge-base."), []);
});

test("gate-by-hand needs a gate word and a moment, and is off without gate words", () => {
  assert.deepEqual(rulesOf("Run tools/x/gate.sh when you like.", GATE), []);
  assert.deepEqual(rulesOf("Run tools/x/gate.sh prior to pushing.", GATE), ["gate-by-hand"]);
  assert.deepEqual(rulesOf("Always run tools/x/gate.sh.", GATE), ["gate-by-hand"]);
  assert.deepEqual(rulesOf("Run tools/x/gate.sh before every commit."), []);
  assert.deepEqual(rulesOf("Run tools/x/gate.sh before every commit.", []), []);
});

test("the first rule that fires wins: a line gives one finding", () => {
  assert.deepEqual(rulesOf("Start every session; every task goes through `/agentry:go`."), [
    "go-for-tasks",
  ]);
});

test("an unclosed fence or comment skips the rest of the file", () => {
  const line = CASES["go-for-tasks"].fires;
  assert.equal(lintText("F.md", `${line}\n\`\`\`\n${line}\n${line}\n`).length, 1);
  assert.equal(lintText("F.md", `${line}\n<!--\n${line}\n`).length, 1);
  assert.equal(lintText("F.md", `${line}\n~~~\n${line}\n`).length, 1);
});

test("an inline code span stays in the text", () => {
  assert.deepEqual(rulesOf("Run `git merge` by hand."), ["land-by-hand"]);
});

test("a CRLF file with a BOM: line 1 is the first line, and no carriage return prints", () => {
  const line = CASES["go-for-tasks"].fires;
  const [f] = lintText("F.md", `﻿# T\r\n\r\n${line}\r\n`);
  assert.equal(f.line, 3);
  assert.equal(f.text, line);
  assert.ok(!f.text.includes("\r"));
  assert.equal(lintText("F.md", `﻿${line}\r\n`)[0].line, 1);
});

test("a long line is cut to 100 code points with an ellipsis; an empty file has no findings", () => {
  const long = `Every task goes through \`/agentry:go\` ${"é".repeat(5000)}`;
  const [f] = lintText("F.md", long);
  assert.equal([...f.text].length, 100);
  assert.ok(f.text.endsWith("…"));
  assert.deepEqual(lintText("F.md", ""), []);
});

test("a generic repo CLAUDE.md gives exactly the three competing lines", () => {
  const text = [
    "# Project",
    "",
    "Start every session by reading docs/STATE.md.",
    "",
    "- Keep `tools/checker` OK at the start and the end of every session.",
    "- Every task goes through `/agentry:go`.",
    "- A task with an id goes through `/agentry:exec <id>`, other work through `/agentry:go`.",
    "",
  ].join("\n");
  const found = lintText("CLAUDE.md", text);
  assert.deepEqual(
    found.map((f) => [f.line, f.rule]),
    [
      [3, "session-routine"],
      [5, "session-routine"],
      [6, "go-for-tasks"],
    ],
  );
});

test("Agentry's own block and conductor template are lint-clean", () => {
  const block = renderBlock(readFileSync(TEMPLATE, "utf8"), { prompt: "docs/CONDUCTOR.md" });
  assert.deepEqual(lintText("AGENTS.md", `${block}\n`), []);
  const conductor = readFileSync(join(TEMPLATES, "CONDUCTOR.md"), "utf8");
  assert.deepEqual(lintText("docs/CONDUCTOR.md", conductor), []);
});

// board instructions --lint

const COMPETING = "Every task goes through `/agentry:go`.\n";
const SPEC = {};
const snapshot = (root) =>
  readdirSync(root, { recursive: true })
    .sort()
    .map((name) => {
      const s = statSync(join(root, name));
      return [name, s.isFile() ? readFileSync(join(root, name)).toString("hex") : "", s.mtimeMs];
    });
const lint = (root, argv = ["--lint"], spec = SPEC) => run(argv, { root, spec });

test("--lint prints each finding with its replacement, a summary, exit 1, and writes nothing", () => {
  const root = repo({ "AGENTS.md": "# A\n", "CLAUDE.md": `# C\n\n${COMPETING}` });
  const before = snapshot(root);
  const { exit, out } = lint(root);
  assert.equal(exit, 1);
  assert.deepEqual(out.split("\n"), [
    "! CLAUDE.md:3  go-for-tasks  Every task goes through `/agentry:go`.",
    "    → A task with a board id goes through `/agentry:exec <id>`; `/agentry:go` is for work with no board id.",
    "lint: 1 competing line(s) in 1 file(s) · suggest only, nothing written",
  ]);
  assert.deepEqual(snapshot(root), before);
});

test("--lint with nothing to say is exit 0 and names the files it read", () => {
  const root = repo({ "AGENTS.md": "# A\n", ".claude/CLAUDE.md": "" });
  const { exit, out } = lint(root);
  assert.equal(exit, 0);
  assert.equal(out, "lint: no competing lines (AGENTS.md, .claude/CLAUDE.md)");
  assert.equal(lint(repo()).out, "lint: no competing lines (no instruction files)");
});

test("--lint reads the four files and the conductor prompt in order, findings by file then line", () => {
  const root = repo({
    "AGENTS.md": `a\n${COMPETING}`,
    "CLAUDE.md": COMPETING,
    ".claude/CLAUDE.md": COMPETING,
    "CLAUDE.local.md": COMPETING,
    "docs/CONDUCTOR.md": `x\n\n${COMPETING}`,
  });
  const spec = { conductor: { prompt: "docs/CONDUCTOR.md" } };
  const { files, findings } = JSON.parse(lint(root, ["--lint", "--json"], spec).out);
  assert.deepEqual(
    files.map((f) => [f.file, f.state]),
    [
      ["AGENTS.md", "read"],
      ["CLAUDE.md", "read"],
      [".claude/CLAUDE.md", "read"],
      ["CLAUDE.local.md", "read"],
      ["docs/CONDUCTOR.md", "read"],
    ],
  );
  assert.deepEqual(
    findings.map((f) => [f.file, f.line]),
    [
      ["AGENTS.md", 2],
      ["CLAUDE.md", 1],
      [".claude/CLAUDE.md", 1],
      ["CLAUDE.local.md", 1],
      ["docs/CONDUCTOR.md", 3],
    ],
  );
  assert.deepEqual(Object.keys(findings[0]).sort(), ["file", "line", "rule", "suggest", "text"]);
});

test("--lint --json lists absent files and exits like the text form", () => {
  const root = repo({ "AGENTS.md": "# A\n" });
  const res = lint(root, ["--lint", "--json"]);
  assert.equal(res.exit, 0);
  assert.deepEqual(JSON.parse(res.out), {
    files: [
      { file: "AGENTS.md", state: "read" },
      { file: "CLAUDE.md", state: "absent" },
      { file: ".claude/CLAUDE.md", state: "absent" },
      { file: "CLAUDE.local.md", state: "absent" },
    ],
    findings: [],
  });
});

test("a file read through two names is read and reported once", () => {
  const root = repo({ "AGENTS.md": COMPETING, "docs/P.md": "# P\n" });
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  const res = lint(root, ["--lint", "--json"], { conductor: { prompt: "AGENTS.md" } });
  const { files, findings } = JSON.parse(res.out);
  assert.equal(findings.length, 1);
  assert.deepEqual(
    files.filter((f) => f.state === "read").map((f) => f.file),
    ["AGENTS.md"],
  );
});

test("a CLAUDE.md that links out of the repo is skipped by name and the rest are still linted", () => {
  const outside = repo({ "CLAUDE.md": COMPETING });
  const root = repo({ "AGENTS.md": COMPETING });
  symlinkSync(join(outside, "CLAUDE.md"), join(root, "CLAUDE.md"));
  const { exit, out } = lint(root);
  assert.equal(exit, 1);
  assert.match(out, /^skip: CLAUDE\.md: .*symlink out of the repository$/m);
  assert.match(out, /^! AGENTS\.md:1 {2}go-for-tasks/m);
  const json = JSON.parse(lint(root, ["--lint", "--json"]).out);
  assert.equal(json.files.find((f) => f.file === "CLAUDE.md").state, "skipped");
  assert.match(json.files.find((f) => f.file === "CLAUDE.md").why, /symlink out/);
});

test("a file that is not UTF-8 is linted, its odd byte shown as U+FFFD", () => {
  const root = repo();
  writeFileSync(
    join(root, "CLAUDE.md"),
    Buffer.concat([Buffer.from("caf"), Buffer.from([0xff]), Buffer.from(` ${COMPETING}`)]),
  );
  const { exit, out } = lint(root);
  assert.equal(exit, 1);
  assert.match(out, /^! CLAUDE\.md:1 {2}go-for-tasks {2}caf� Every task/m);
});

test("a CRLF AGENTS.md with a BOM: the editor's line numbers, and no \\r printed", () => {
  const root = repo({ "AGENTS.md": `﻿# A\r\n\r\n${COMPETING.replace("\n", "\r\n")}` });
  const { out } = lint(root);
  assert.match(
    out,
    /^! AGENTS\.md:3 {2}go-for-tasks {2}Every task goes through `\/agentry:go`\.$/m,
  );
  assert.ok(!out.includes("\r"));
});

test("a 5,000-character line prints cut to 100 code points", () => {
  const root = repo({
    "CLAUDE.md": `Every task goes through \`/agentry:go\` ${"x".repeat(5000)}\n`,
  });
  const first = lint(root).out.split("\n")[0];
  const shown = first.replace(/^! CLAUDE\.md:1 {2}go-for-tasks {2}/, "");
  assert.equal([...shown].length, 100);
  assert.ok(shown.endsWith("…"));
});

test("gate-by-hand: a gate script file adds its path and basename as words", () => {
  const gate = { tiers: [{ name: "full", command: ["bash", "tools/x/gate.sh"] }] };
  const line = "run tools/x/gate.sh before every commit\n";
  const present = repo({ "CLAUDE.md": line, "tools/x/gate.sh": "#!/bin/sh\n" });
  const res = lint(present, ["--lint"], { gate });
  assert.equal(res.exit, 1);
  assert.match(res.out, /gate-by-hand/);
  assert.match(res.out, /run the gate \(`bash tools\/x\/gate\.sh`\)/);
  const basename = repo({
    "CLAUDE.md": "Run gate.sh before every commit\n",
    "tools/x/gate.sh": "",
  });
  assert.equal(lint(basename, ["--lint"], { gate }).exit, 1);
  const absent = repo({ "CLAUDE.md": line });
  assert.equal(lint(absent, ["--lint"], { gate }).exit, 0, "no such file: no word");
  const folder = repo({ "CLAUDE.md": "run tools before every commit\n" });
  mkdirSync(join(folder, "tools"));
  const dir = { tiers: [{ name: "full", command: ["ls", "tools"] }] };
  assert.equal(lint(folder, ["--lint"], { gate: dir }).exit, 0, "a folder adds no word");
});

test("gate-by-hand: the single-file gate fires, no gate gives nothing, a sh -c script is no file", () => {
  const line = "run tools/x/gate.sh before every commit\n";
  const root = repo({ "CLAUDE.md": line, "tools/x/gate.sh": "" });
  const single = { tiers: [{ name: "full", command: ["tools/x/gate.sh"] }] };
  assert.match(lint(root, ["--lint"], { gate: single }).out, /^! CLAUDE\.md:1 {2}gate-by-hand/m);
  assert.equal(lint(root, ["--lint"], {}).exit, 0, "no gate set");
  const script = "make check && make lint";
  const quoted = repo({ "CLAUDE.md": `Run \`${script}\` before every commit\n` });
  const shell = { tiers: [{ name: "full", command: ["sh", "-c", script] }] };
  assert.equal(lint(quoted, ["--lint"], { gate: shell }).exit, 0);
});

test("--lint takes no --apply or --target, and a bad --target is a usage error; nothing changes", () => {
  const root = repo({ "AGENTS.md": "# A\n", "CLAUDE.md": COMPETING });
  const before = snapshot(root);
  for (const argv of [
    ["--lint", "--apply"],
    ["--lint", "--target", "local"],
    ["--target", "nope"],
    ["--target", "LOCAL"],
    ["--target"],
    ["--target", "--apply"],
  ]) {
    const res = run(argv, { root, spec: SPEC });
    assert.equal(res.exit, 2, argv.join(" "));
  }
  assert.match(
    run(["--lint", "--apply"], { root, spec: SPEC }).out,
    /--lint only reads; it takes no --apply or --target/,
  );
  assert.deepEqual(snapshot(root), before);
});
