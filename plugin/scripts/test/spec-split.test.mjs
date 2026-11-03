// The process file split in two: the board (`process.json`) and its sibling workflow file
// (`workflow.json`). A key in the other file is refused by name with the file it belongs in, through
// the board CLI; a board with no workflow file loads with every workflow default; a workflow file that
// is not JSON or cannot be read refuses, naming it; each check that reads both files names the file
// holding its key; and the module structure holds (sizes and import direction).
// Run: node --test plugin/scripts/test/spec-split.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSpec } from "../lib/process/read.mjs";
import * as composed from "../lib/process/spec.mjs";
import { BOARD_KEYS, WORKFLOW_KEYS, validateSpec } from "../lib/process/spec.mjs";
import { checkAcross, checkDone, checkHandoff } from "../lib/process/spec/across.mjs";
import { gateOf, modelFor, verifyRoute } from "../lib/process/spec/workflow.mjs";
import { BASE } from "./key-cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..");
const BOARD = join(SCRIPTS, "board.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A scratch repo with BASE's board as process.json and, given, `workflow` as workflow.json (a string
// is written as it is). Returns the runner of `board check` on it.
function scratch(board, workflow) {
  const root = mkdtempSync(join(tmpdir(), "agentry-split-"));
  temps.push(root);
  mkdirSync(join(root, "board"));
  writeFileSync(
    join(root, "board", "BOARD.md"),
    "## Tasks\n\n| Task | Status |\n| --- | --- |\n| T1 | todo |\n",
  );
  writeFileSync(join(root, "process.json"), JSON.stringify(board));
  if (workflow !== undefined)
    writeFileSync(
      join(root, "workflow.json"),
      typeof workflow === "string" ? workflow : JSON.stringify(workflow),
    );
  const check = () =>
    spawnSync("node", [BOARD, "check", "--root", root, "--process", join(root, "process.json")], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
  return { root, check };
}

test("the key lists come from the two schemas and split the twelve workflow keys from the six board keys", () => {
  assert.deepEqual(BOARD_KEYS, ["version", "name", "root", "kinds", "rules", "status"]);
  assert.deepEqual(WORKFLOW_KEYS, [
    "lifecycle",
    "drafts",
    "worktrees",
    "gate",
    "extensions",
    "conductor",
    "guard",
    "cleanup",
    "exec",
    "models",
    "briefs",
    "commits",
  ]);
  assert.ok(!WORKFLOW_KEYS.includes("version"));
  assert.ok(WORKFLOW_KEYS.every((k) => !BOARD_KEYS.includes(k)));
});

test("each workflow key in process.json is exit 2 naming the key and workflow.json", () => {
  for (const key of WORKFLOW_KEYS) {
    const res = scratch({ ...BASE, [key]: {} }).check();
    assert.equal(res.status, 2, key);
    assert.match(res.stderr, /^✗ process\.json: cannot use the process file → /, key);
    assert.match(
      res.stderr,
      new RegExp(`\n {2}${key} is a workflow key: it belongs in workflow\\.json`),
    );
    assert.doesNotMatch(res.stderr, /is not a known key/, key);
  }
});

test("each board key in workflow.json is exit 2 naming the key and the process file", () => {
  for (const key of BOARD_KEYS) {
    const res = scratch(BASE, { [key]: BASE[key] ?? {} }).check();
    assert.equal(res.status, 2, key);
    assert.match(res.stderr, /^✗ workflow\.json: cannot use the workflow file → /, key);
    assert.match(
      res.stderr,
      new RegExp(`\n {2}${key} is a board key: it belongs in process\\.json`),
    );
  }
});

test("a misplaced key's problem is filed under the file that holds it; an unknown key keeps its message", () => {
  const files = { board: "/r/.agentry/board.json", workflow: "/r/.agentry/workflow.json" };
  const inBoard = validateSpec({ board: { ...BASE, gate: {} } }, { files }).problems;
  assert.deepEqual(inBoard, [
    {
      rule: "spec",
      message: "gate is a workflow key: it belongs in workflow.json",
      file: files.board,
    },
  ]);
  const inWorkflow = validateSpec({ board: BASE, workflow: { rules: [] } }, { files }).problems;
  assert.deepEqual(inWorkflow, [
    {
      rule: "spec",
      message: "rules is a board key: it belongs in board.json",
      file: files.workflow,
    },
  ]);
  const unknown = validateSpec({ board: BASE, workflow: { gates: {} } }, { files }).problems;
  assert.equal(unknown[0].file, files.workflow);
  assert.match(unknown[0].message, /^gates is not a known key \(expected "lifecycle", "drafts"/);
  const unknownBoard = validateSpec({ board: { ...BASE, gates: {} } }, { files }).problems;
  assert.match(unknownBoard[0].message, /^gates is not a known key \(expected "version", "name"/);
});

test("with no workflow.json the board-only fixtures load with every workflow default", () => {
  for (const name of ["evidence-board", "frontmatter-board", "write"]) {
    const { spec, problems } = loadSpec(join(HERE, "fixtures", name, "process.json"));
    assert.deepEqual(problems, [], name);
    assert.equal(gateOf(spec), null, name);
    assert.equal(verifyRoute(spec), "all", name);
    assert.equal(modelFor(spec, "build"), null, name);
    assert.equal(modelFor(spec, "verify", { flagged: true, ui: true }), null, name);
  }
});

test("a workflow.json that is not JSON, or cannot be read, is exit 2 naming it", () => {
  const bad = scratch(BASE, "{ not json").check();
  assert.equal(bad.status, 2);
  assert.match(
    bad.stderr,
    /^✗ workflow\.json: cannot use the workflow file → .*\n {2}not valid JSON/,
  );
  assert.doesNotMatch(bad.stderr, /cannot use the process file/);
  const dir = scratch(BASE);
  mkdirSync(join(dir.root, "workflow.json"));
  const unread = dir.check();
  assert.equal(unread.status, 2);
  assert.match(
    unread.stderr,
    /workflow\.json: cannot use the workflow file[^\n]*\n {2}cannot read the workflow file \(EISDIR\)/,
  );
});

test("problems in both files print one block per file, the process file first", () => {
  const res = scratch({ ...BASE, name: 7 }, { gate: { command: [] } }).check();
  assert.equal(res.status, 2);
  const lines = res.stderr.trimEnd().split("\n");
  assert.match(lines[0], /^✗ process\.json: cannot use the process file → /);
  assert.equal(lines[1], "  name should be a string");
  assert.match(lines[2], /^✗ workflow\.json: cannot use the workflow file → /);
  assert.equal(lines[3], "  gate.command should not be empty");
  assert.equal(lines.length, 4);
});

// ---- the process file's own name and the files a symlink takes out --------------------------------

// `board check` on `file` under the scratch repo's root, as the process file.
const checkAs = (root, file) =>
  spawnSync("node", [BOARD, "check", "--root", root, "--process", file], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

test("a process file named workflow.json is exit 2 pointing at .agentry/process.json", () => {
  const { root } = scratch(BASE, {});
  const file = join(root, "workflow.json");
  writeFileSync(file, JSON.stringify(BASE));
  const res = checkAs(root, file);
  assert.equal(res.status, 2);
  assert.match(
    res.stderr,
    /the process file cannot be named workflow\.json \(its sibling workflow file would be itself\) → use \.agentry\/process\.json/,
  );
});

test("a workflow.json or process.json that a symlink takes out of the repository is exit 2", () => {
  for (const name of ["workflow.json", "process.json"]) {
    const { root, check } = scratch(BASE, {});
    const outside = mkdtempSync(join(tmpdir(), "agentry-outside-"));
    temps.push(outside);
    writeFileSync(join(outside, "x.json"), name === "workflow.json" ? "{}" : JSON.stringify(BASE));
    rmSync(join(root, name));
    symlinkSync(join(outside, "x.json"), join(root, name));
    const res = check();
    assert.equal(res.status, 2, name);
    assert.match(
      res.stderr,
      new RegExp(`${name.replace(".", "\\.")} leaves the repository through a symlink`),
    );
  }
});

test("a workflow.json that is a symlink inside the repository still loads", () => {
  const { root, check } = scratch(BASE, {});
  rmSync(join(root, "workflow.json"));
  writeFileSync(join(root, "real-workflow.json"), "{}");
  symlinkSync(join(root, "real-workflow.json"), join(root, "workflow.json"));
  const res = check();
  assert.notEqual(res.status, 2, res.stderr);
});

// ---- the checks that read both files (across.mjs) ------------------------------------------------

const FILES = { board: "process.json", workflow: "workflow.json" };
// A board whose tasks sit in sprints with a bold-lead handoff section, and a lifecycle on tasks.
const SPRINTED = {
  ...BASE,
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", done: "done" } },
      file: { glob: "s/{id}.md", sections: { handoff: { heading: "Handoff", as: "bold-lead" } } },
    },
    task: {
      ...BASE.kinds.task,
      fields: {
        ...BASE.kinds.task.fields,
        sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
        signed: { column: "Signed", type: "date" },
      },
    },
  },
  rules: [{ rule: "done-has-handoff", kind: "task", section: "handoff" }],
};
const LIFECYCLE = {
  kind: "task",
  on: { dispatched: "doing", merged: "done" },
  write: { status: "status", handoff: "parent.file:handoff" },
  handoff: "- **{id}** ({sha}): {summary}",
};
// Each problem as [file, message], and what the across check alone says of the merged spec.
const filed = (board, workflow) =>
  validateSpec({ board, workflow }, { files: FILES }).problems.map((p) => [p.file, p.message]);
const alone = (check, board, workflow) => {
  const said = [];
  check({ ...board, ...workflow }, (at, message) => said.push(`${at} ${message}`));
  return said;
};

test("the sprinted board and its lifecycle load clean", () => {
  assert.deepEqual(filed(SPRINTED, { lifecycle: LIFECYCLE }), []);
});

test("an unknown lifecycle.kind fails from across.mjs, in the workflow file", () => {
  const workflow = { lifecycle: { ...LIFECYCLE, kind: "story" } };
  const message = 'lifecycle.kind names an unknown kind "story"';
  assert.deepEqual(filed(SPRINTED, workflow), [["workflow.json", message]]);
  assert.deepEqual(alone(checkAcross, SPRINTED, workflow), [message]);
});

test('exec.verify "flagged" with no flag field fails from across.mjs, in the workflow file', () => {
  const workflow = { lifecycle: LIFECYCLE, exec: { verify: "flagged" } };
  const message =
    'exec.verify is "flagged", but the task kind has no field named "flag" of type "flag"';
  assert.deepEqual(filed(SPRINTED, workflow), [["workflow.json", message]]);
  assert.deepEqual(alone(checkAcross, SPRINTED, workflow), [message]);
});

test("a handoff template the done-has-handoff rule rejects fails from across.mjs, in the workflow file", () => {
  const workflow = { lifecycle: { ...LIFECYCLE, handoff: "- {id} ({sha}): {summary}" } };
  const [[file, message], ...rest] = filed(SPRINTED, workflow);
  assert.deepEqual(rest, []);
  assert.equal(file, "workflow.json");
  assert.match(message, /^lifecycle\.handoff renders .*rules\[0\] \(done-has-handoff\) rejects/);
  assert.deepEqual(alone(checkHandoff, SPRINTED, workflow), [message]);
});

test("done-signoff on the lifecycle's kind fails from across.mjs, naming rules[i] in the process file", () => {
  const board = {
    ...SPRINTED,
    rules: [...SPRINTED.rules, { rule: "done-signoff", kind: "task", field: "signed" }],
  };
  const workflow = { lifecycle: LIFECYCLE };
  const message =
    'rules[1] (done-signoff) needs a dated sign-off on a done task, which "merged" never writes';
  assert.deepEqual(filed(board, workflow), [["process.json", message]]);
  assert.deepEqual(alone(checkDone, board, workflow), [message]);
});

// ---- structure ------------------------------------------------------------------------------------

const PROCESS = join(SCRIPTS, "lib", "process");
const lines = (file) => readFileSync(file, "utf8").split("\n").length - 1;
// Every import a module's text makes, once: `import … from`, bare `import "x"`, `export … from` and
// dynamic `import("x")`. `names` are the named imports plus "default" for a default one.
const importsIn = (text) => {
  const named = (clause) =>
    (/\{([^}]*)\}/.exec(clause)?.[1] ?? "")
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0])
      .filter(Boolean);
  const hasDefault = (clause) => /^\s*[\w$]+\s*(,|$)/.test(clause);
  const statics = [
    ...text.matchAll(/^(?:import|export)\s+(?:([^;"']+?)\s+from\s+)?["']([^"']+)["']/gm),
  ];
  const dynamics = [...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)];
  return [
    ...statics.map(([, clause = "", from]) => ({
      names: [...(hasDefault(clause) ? ["default"] : []), ...named(clause)],
      from,
    })),
    ...dynamics.map(([, from]) => ({ names: [], from })),
  ];
};
const importsOf = (file) => importsIn(readFileSync(file, "utf8"));
const sources = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (d) => d.isFile() && /\.(mjs|ts)$/.test(d.name) && !d.parentPath.includes("node_modules"),
    )
    .map((d) => join(d.parentPath, d.name));

test("spec.mjs is at most 120 lines and no spec/*.mjs file is over 300", () => {
  assert.ok(
    lines(join(PROCESS, "spec.mjs")) <= 120,
    `spec.mjs: ${lines(join(PROCESS, "spec.mjs"))}`,
  );
  for (const name of readdirSync(join(PROCESS, "spec")))
    assert.ok(
      lines(join(PROCESS, "spec", name)) <= 300,
      `spec/${name}: ${lines(join(PROCESS, "spec", name))}`,
    );
});

// What each spec module must not import, by the module's file name.
const FORBIDDEN = {
  "workflow.mjs": /\/(board|rules|across)\.mjs$/,
  "board.mjs": /\/(workflow|across)\.mjs$/,
  "rules.mjs": /^\.\/(board|workflow|across)\.mjs$/,
};
const breaks = (name, file) =>
  importsOf(file)
    .map((i) => i.from)
    .filter((f) => FORBIDDEN[name].test(f));

test("the imports point one way: workflow.mjs sees no board, board.mjs no workflow", () => {
  for (const name of Object.keys(FORBIDDEN))
    assert.deepEqual(breaks(name, join(PROCESS, "spec", name)), [], name);
});

test("the import reader sees each form once: named, default, namespace, bare, export-from, dynamic", () => {
  const text = [
    'import { a, b as c } from "./named.mjs";',
    'import dflt from "./default.mjs";',
    'import * as ns from "./namespace.mjs";',
    'import "./bare.mjs";',
    'export { d } from "./reexport.mjs";',
    'const lazy = await import("./dynamic.mjs");',
    'export const local = "./not-an-import.mjs";',
  ].join("\n");
  assert.deepEqual(importsIn(text), [
    { names: ["a", "b"], from: "./named.mjs" },
    { names: ["default"], from: "./default.mjs" },
    { names: [], from: "./namespace.mjs" },
    { names: [], from: "./bare.mjs" },
    { names: ["d"], from: "./reexport.mjs" },
    { names: [], from: "./dynamic.mjs" },
  ]);
});

test("a namespace import of workflow.mjs planted in a copy of board.mjs fails the direction rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-planted-"));
  temps.push(dir);
  const copy = join(dir, "board.mjs");
  copyFileSync(join(PROCESS, "spec", "board.mjs"), copy);
  assert.deepEqual(breaks("board.mjs", copy), []);
  writeFileSync(copy, `${readFileSync(copy, "utf8")}\nimport * as W from "./workflow.mjs";\n`);
  assert.deepEqual(breaks("board.mjs", copy), ["./workflow.mjs"]);
});

test("nothing imports a moved name from spec.mjs", () => {
  const own = Object.keys(composed);
  const repo = join(SCRIPTS, "..", "..");
  const files = [...sources(join(repo, "plugin", "scripts")), ...sources(join(repo, "packages"))];
  const moved = files.flatMap((file) =>
    importsOf(file)
      .filter((i) => /(^|\/)process\/spec\.mjs$|^\.\.?\/spec\.mjs$/.test(i.from))
      .flatMap((i) =>
        i.names.filter((n) => !own.includes(n)).map((n) => `${relative(repo, file)}: ${n}`),
      ),
  );
  assert.deepEqual(moved, []);
});
