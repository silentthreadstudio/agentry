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
import { writeSpec } from "./spec-files.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, "..", "board.mjs");

// A git repo holding the table board, whose process and workflow files get `extra` keys (`only`: just
// these keys, no fixture lifecycle or drafts). Returns `board` to run a subcommand on it and `lanes()`
// for explain's lane rows by name.
function repo(extra = {}, { only = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentry-lanes-"));
  cpSync(join(HERE, "fixtures", "table-board"), root, { recursive: true });
  const json = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
  const fixture = only
    ? json("process.json")
    : { ...json("process.json"), ...json("workflow.json") };
  const file = writeSpec(root, { ...fixture, ...extra });
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

test("a repo with no lanes set up lists each as ✗ with its command, an absent optional key as ·, and still exits 0", () => {
  const { root, board, lanes } = repo();
  try {
    const res = board("explain");
    assert.equal(res.status, 0);
    const block = res.stdout.split("\nlanes")[1];
    assert.ok(block, "a lanes block follows the rules");
    for (const lane of ["trigger block", "default agent", "merge.push"])
      assert.match(block, new RegExp(`^✗ +${lane.replace(".", "\\.")} `, "m"), lane);
    for (const lane of [
      "gate.tiers",
      "gate.checklist",
      "conductor.prompt",
      "models",
      "merge.checks",
    ])
      assert.match(block, new RegExp(`^· +${lane.replace(".", "\\.")} +none$`, "m"), lane);
    assert.doesNotMatch(block, /set: \/agentry:init\n.*\n?^· /m);
    assert.match(block, /set: board instructions --apply/);
    assert.match(block, /set: board default-agent --apply/);
    assert.match(block, /set: \/agentry:config merge\.push=/);
    const rows = lanes();
    assert.equal(rows["gate.tiers"].ok, false);
    assert.equal(rows.gate, undefined);
    assert.equal(rows["gate.roles"], undefined);
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
      tiers: [
        {
          name: "docs-and-markdown-only",
          command: ["tools/ci/gate.sh", "--quick"],
          when: { only: ["docs/**", "**/*.md"] },
        },
        {
          name: "the-whole-test-suite",
          command: ["tools/ci/gate.sh", "--with-a-long-flag-name"],
          when: { any: ["src/**"], flag: true },
        },
        { name: "full", command: ["tools/ci/gate.sh"] },
      ],
      checklist: [
        { name: "ui-smoke", text: "Open each screen", when: { any: ["src/ui/**"], flag: true } },
        { name: "owner-saw-it-running", text: "The owner saw it" },
      ],
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
    gate: {
      tiers: [
        { name: "docs", command: ["make", "docs"], when: { only: ["docs/**"] } },
        { name: "full", command: ["make", "check"] },
      ],
    },
    extensions: { merge: { checks: ["repo-merge"] } },
    conductor: { prompt: "CONDUCTOR.md", rules: "Standing rules" },
  });
  try {
    write(root, "CONDUCTOR.md", "# Conductor\n\n## Standing rules\n\n- one\n");
    write(root, ".agentry/config.json", JSON.stringify({ merge: { push: "auto" } }));
    assert.equal(board("instructions", "--apply").status, 0);
    assert.equal(board("default-agent", "--apply").status, 0);
    const rows = lanes();
    for (const lane of [
      "gate.tiers",
      "gate.roles",
      "conductor.prompt",
      "conductor.rules",
      "trigger block",
      "default agent",
      "merge.push",
      "merge.checks",
    ])
      assert.equal(rows[lane].ok, true, lane);
    assert.equal(rows["gate.tiers"].value, "docs (only 1 glob) → full");
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
    assert.equal(board("instructions", "--apply").status, 0);
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

// A developer's own global ignore file must not decide whether CLAUDE.local.md is ignored.
function withCleanGit(body) {
  const keep = { ...process.env };
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agentry-xdg-"));
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    body();
  } finally {
    rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true });
    for (const k of ["XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"])
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
  }
}

test("a trigger block in CLAUDE.local.md is ✓ when git ignores the file", () =>
  withCleanGit(() => {
    const { root, board, lanes } = repo({ conductor: { prompt: "CONDUCTOR.md" } });
    try {
      write(root, "CONDUCTOR.md", "# Conductor\n");
      write(root, ".gitignore", "CLAUDE.local.md\n");
      assert.equal(board("instructions", "--target", "local", "--apply").status, 0);
      const row = lanes()["trigger block"];
      assert.deepEqual([row.ok, row.value], [true, "CLAUDE.local.md block is current"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

test("a trigger block in CLAUDE.local.md that git does not ignore, or tracks, is ✗ with the .gitignore line", () =>
  withCleanGit(() => {
    const { root, board, lanes } = repo({ conductor: { prompt: "CONDUCTOR.md" } });
    try {
      write(root, "CONDUCTOR.md", "# Conductor\n");
      assert.equal(board("instructions", "--target", "local", "--apply").status, 0);
      const row = lanes()["trigger block"];
      assert.deepEqual(
        [row.ok, row.value, row.set],
        [
          false,
          "CLAUDE.local.md block is current, but git does not ignore it",
          "echo CLAUDE.local.md >> .gitignore",
        ],
      );
      assert.match(board("explain").stdout, /set: echo CLAUDE\.local\.md >> \.gitignore/);
      write(root, ".gitignore", "CLAUDE.local.md\n");
      execFileSync("git", ["-C", root, "add", "-f", "CLAUDE.local.md"]);
      assert.equal(lanes()["trigger block"].ok, false, "tracked, though ignored");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

test("a block in both AGENTS.md and CLAUDE.local.md is ✗ with the refusal's words", () => {
  const { root, board, lanes } = repo({ conductor: { prompt: "CONDUCTOR.md" } });
  try {
    write(root, "CONDUCTOR.md", "# Conductor\n");
    assert.equal(board("instructions", "--apply").status, 0);
    write(root, "CLAUDE.local.md", readFileSync(join(root, "AGENTS.md"), "utf8"));
    const row = lanes()["trigger block"];
    assert.equal(row.ok, false);
    assert.equal(
      row.value,
      "AGENTS.md and CLAUDE.local.md both hold an Agentry block; remove one by hand",
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

test("each newer key that is set shows a row with what it matches; an unset one shows none", () => {
  const { root, board, lanes } = repo({
    worktrees: { keep: ["side-*"] },
    guard: { allow: ["notes/**"] },
    cleanup: { disposable: ["build/**"] },
    gate: {
      tiers: [{ name: "full", command: ["make", "check"] }],
      flaky: ["a", "b", "c"],
      concurrency: 2,
    },
  });
  try {
    const tree = `${root}-side`;
    write(root, "notes/a.md", "a");
    write(root, "notes/b.md", "b");
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "x",
    ]);
    execFileSync("git", ["-C", root, "worktree", "add", "-q", tree, "-b", "side-one"]);
    const rows = lanes();
    assert.equal(rows["worktrees.keep"].value, "1 worktree: side-*");
    assert.equal(rows["guard.allow"].value, "2 tracked files: notes/**");
    assert.equal(rows["cleanup.disposable"].value, "build/**");
    assert.equal(rows["gate.flaky"].value, "3 names");
    assert.equal(rows["gate.concurrency"].value, "2 slots");
    assert.match(board("explain").stdout, /^✓ +gate\.flaky +3 names$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-side`, { recursive: true, force: true });
  }
  const bare = repo();
  try {
    for (const lane of [
      "worktrees.keep",
      "guard.allow",
      "cleanup.disposable",
      "gate.flaky",
      "gate.concurrency",
    ])
      assert.equal(bare.lanes()[lane], undefined, lane);
  } finally {
    rmSync(bare.root, { recursive: true, force: true });
  }
});

test("briefs and commits rows say what is set, and are absent when the keys are", () => {
  const { root, board, lanes } = repo({
    briefs: { build: ["a", "b"], verify: ["c"] },
    commits: { subjectMax: 72, subjectPattern: "^feat", forbid: ["^Co-Authored-By:"] },
  });
  try {
    const rows = lanes();
    assert.equal(rows.briefs.value, "build 2 lines · verify 1 line");
    assert.equal(rows.commits.value, "subject ≤ 72 · pattern · 1 forbid");
    assert.equal(rows.briefs.ok, true);
    assert.match(board("explain").stdout, /^✓ +briefs +build 2 lines · verify 1 line$/m);
    assert.match(board("explain").stdout, /^✓ +commits +subject ≤ 72 · pattern · 1 forbid$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const part = repo({ briefs: { verify: ["c"] }, commits: { forbid: ["x", "y"] } });
  try {
    assert.equal(part.lanes().briefs.value, "verify 1 line");
    assert.equal(part.lanes().commits.value, "2 forbid");
  } finally {
    rmSync(part.root, { recursive: true, force: true });
  }
  const bare = repo();
  try {
    assert.equal(bare.lanes().briefs, undefined);
    assert.equal(bare.lanes().commits, undefined);
  } finally {
    rmSync(bare.root, { recursive: true, force: true });
  }
});

test("a long guard.allow list is cut in its globs, never in its count", () => {
  const globs = ["notes/**", ...Array.from({ length: 8 }, (_, i) => `some/long/dir-${i}/**`)];
  const { root, board } = repo({ guard: { allow: globs } });
  try {
    write(root, "notes/a.md", "a");
    execFileSync("git", ["-C", root, "add", "-A"]);
    const line = board("explain")
      .stdout.split("\n")
      .find((l) => l.includes("guard.allow"));
    assert.ok([...line].length <= 80, line);
    assert.match(line, /^✓ +guard\.allow +1 tracked file: notes\/\*\*, /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first lanes row names the preset and the workflow file, or none; --json names both files", () => {
  const { root, board, lanes } = repo({
    gate: { tiers: [{ name: "full", command: ["make", "check"] }] },
  });
  try {
    const rows = lanes();
    assert.deepEqual(rows.workflow, {
      lane: "workflow",
      ok: true,
      value: "standard · workflow.json",
      set: "/agentry:init",
      workflow: {
        preset: "standard",
        exec: { verify: "all", noteRounds: 1, final: "after-fix", rebase: "recheck" },
        roles: { build: "pick", verify: "none", merge: "pick" },
        set: [],
      },
      keys: ["lifecycle", "drafts", "gate"],
    });
    const block = board("explain").stdout.split("\nlanes")[1].split("\n");
    assert.match(block[1], /^✓ +workflow +standard · workflow\.json$/);
    const data = JSON.parse(board("explain", "--json").stdout);
    assert.deepEqual(data.files, { process: "process.json", workflow: "workflow.json" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const bare = repo({}, { only: true });
  try {
    const row = bare.lanes().workflow;
    assert.deepEqual([row.ok, row.value, row.set], [false, "standard · none", "/agentry:init"]);
    assert.match(
      bare.board("explain").stdout,
      /^✗ +workflow +standard · none\n +set: \/agentry:init$/m,
    );
    assert.equal(JSON.parse(bare.board("explain", "--json").stdout).files.workflow, null);
  } finally {
    rmSync(bare.root, { recursive: true, force: true });
  }
});

test("the commit policy has a .agentry/workflow.json row right after .agentry/process.json", () => {
  const { root, lanes } = repo();
  try {
    write(root, ".agentry/workflow.json", "{}");
    execFileSync("git", ["-C", root, "add", ".agentry/workflow.json"]);
    const names = Object.keys(lanes());
    const at = names.indexOf(".agentry/process.json");
    assert.equal(names[at + 1], ".agentry/workflow.json");
    assert.deepEqual(
      [lanes()[".agentry/workflow.json"].ok, lanes()[".agentry/workflow.json"].value],
      [true, "tracked"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate rows: its tiers in order, the tier each role runs, and the checklist", () => {
  const { root, board, lanes } = repo({
    gate: {
      tiers: [
        {
          name: "docs",
          command: ["scripts/gate.sh", "--quick"],
          when: { only: ["docs/**", "*.md"] },
        },
        {
          name: "tests",
          command: ["scripts/gate.sh", "--tests"],
          when: { only: ["src/ui/**", "tests/**"] },
        },
        { name: "full", command: ["scripts/gate.sh"] },
      ],
      roles: { build: "pick", verify: "none", merge: "pick" },
      checklist: [
        {
          name: "ui-smoke",
          text: "Open each changed screen",
          when: { any: ["src/ui/**"], flag: true },
        },
      ],
    },
  });
  try {
    const block = board("explain").stdout.split("\nlanes")[1];
    assert.match(block, /^✓ +gate\.tiers +docs \(only 2 globs\) → tests \(only 2 globs\) → full$/m);
    assert.match(block, /^✓ +gate\.roles +build pick · verify none · merge pick · set$/m);
    assert.match(block, /^✓ +gate\.checklist +1 item: ui-smoke \(any 1 glob, or flagged\)$/m);
    assert.doesNotMatch(block, /^. +gate(\.quick)? /m);
    // The roles row shows the defaults when gate.roles is not set.
    assert.equal(lanes()["gate.roles"].value, "build pick · verify none · merge pick · set");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate.checklist row is always shown: none when the gate has no checklist, or no gate", () => {
  for (const keys of [{ gate: { tiers: [{ name: "full", command: ["make", "check"] }] } }, {}]) {
    const { root, board, lanes } = repo(keys);
    try {
      const row = lanes()["gate.checklist"];
      assert.deepEqual(
        [row.ok, row.value, row.optional],
        [false, "none", true],
        JSON.stringify(keys),
      );
      assert.match(board("explain").stdout.split("\nlanes")[1], /^· +gate\.checklist +none$/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("start and close check rows name the skills, and turn ✗ when one has no SKILL.md", () => {
  const { root, lanes } = repo({
    extensions: {
      start: { checks: ["repo-session"] },
      close: { checks: ["repo-session", "ghost"] },
    },
  });
  try {
    write(root, ".claude/skills/repo-session/SKILL.md", "# s\n");
    const rows = lanes();
    assert.deepEqual(
      [rows["extensions.start.checks"].ok, rows["extensions.start.checks"].value],
      [true, "1 skill: repo-session"],
    );
    assert.deepEqual(
      [rows["extensions.close.checks"].ok, rows["extensions.close.checks"].value],
      [false, "2 skills: repo-session, ghost"],
    );
    assert.equal(rows["extensions.close.checks"].set, "/agentry:init");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no start or close rows when extensions names only merge", () => {
  const { root, lanes } = repo({ extensions: { merge: { checks: ["repo-merge"] } } });
  try {
    const names = Object.keys(lanes());
    assert.ok(!names.some((n) => /^extensions\.(start|close)/.test(n)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the exec rows show each value as the preset resolves it, and where it comes from", () => {
  const { root, board, lanes } = repo({
    gate: { tiers: [{ name: "full", command: ["make", "check"] }] },
    exec: { final: "never" },
  });
  try {
    const block = board("explain").stdout.split("\nlanes")[1].split("\n").slice(1, 7);
    const expected = [
      /^✓ +workflow +standard · workflow\.json$/,
      /^✓ +exec\.verify +all · preset$/,
      /^✓ +exec\.noteRounds +1 \(live\) · preset$/,
      /^✓ +exec\.final +never · set$/,
      /^✓ +exec\.rebase +recheck · preset$/,
      /^✓ +gate\.tiers +full$/,
    ];
    expected.forEach((re, i) => assert.match(block[i], re));
    assert.match(
      board("explain").stdout,
      /^✓ +gate\.roles +build pick · verify none · merge pick · preset$/m,
    );
    const data = JSON.parse(board("explain", "--json").stdout);
    const workflow = data.lanes.find((l) => l.lane === "workflow").workflow;
    assert.deepEqual(workflow.set, ["exec.final"]);
    assert.equal(workflow.exec.final, "never");
    assert.equal(lanes()["exec.final"].value, "never · set");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exec.verify flagged says which field it keys on; a models row names each model, or · none", () => {
  const flagged = (spec) => ({
    ...spec,
    kinds: {
      ...spec.kinds,
      task: {
        ...spec.kinds.task,
        fields: { ...spec.kinds.task.fields, flag: { column: "Flag", type: "flag" } },
      },
    },
  });
  const root0 = mkdtempSync(join(tmpdir(), "agentry-lanes-"));
  cpSync(join(HERE, "fixtures", "table-board"), root0, { recursive: true });
  const base = JSON.parse(readFileSync(join(root0, "process.json"), "utf8"));
  rmSync(root0, { recursive: true, force: true });
  const { root, lanes } = repo({
    ...flagged(base),
    exec: { preset: "lean" },
    models: { build: "sonnet", verify: { default: "haiku", ui: "sonnet", flagged: "opus" } },
  });
  try {
    const rows = lanes();
    assert.equal(
      rows["exec.verify"].value,
      'flagged · keys on the task kind\'s "flag" field · preset',
    );
    assert.equal(rows["exec.noteRounds"].value, "0 (live) · preset");
    assert.equal(rows.models.value, "build sonnet · verify haiku, ui sonnet, flagged opus");
    assert.equal(rows.models.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the models row warns of models.verify.ui under a flagged route, wrapped to 80 columns (field 70)", () => {
  const root0 = mkdtempSync(join(tmpdir(), "agentry-lanes-"));
  cpSync(join(HERE, "fixtures", "table-board"), root0, { recursive: true });
  const base = JSON.parse(readFileSync(join(root0, "process.json"), "utf8"));
  rmSync(root0, { recursive: true, force: true });
  const flagged = {
    ...base,
    kinds: {
      ...base.kinds,
      task: {
        ...base.kinds.task,
        fields: { ...base.kinds.task.fields, flag: { column: "Flag", type: "flag" } },
      },
    },
  };
  const models = {
    build: { default: "sonnet", paths: [{ when: { any: ["src/**"] }, model: "opus" }] },
    verify: { ui: "opus", flagged: "opus-max" },
  };
  const warn =
    "! models.verify.ui is unused: exec.verify is flagged and a UI task is verified only when flagged";
  const warned = repo({ ...flagged, exec: { verify: "flagged" }, models });
  const plain = repo({ ...flagged, models });
  // Without verify.flagged, a flagged UI task takes verify.ui: the key is used.
  const noFlagged = repo({
    ...flagged,
    exec: { verify: "flagged" },
    models: { verify: { ui: "opus" } },
  });
  try {
    const row = warned.lanes().models;
    assert.deepEqual(
      [row.ok, row.value, row.warning],
      [true, "build sonnet (1 path) · verify ui opus, flagged opus-max", warn],
    );
    const lines = warned.board("explain").stdout.split("\n");
    const at = lines.findIndex((l) => /^✓ +models /.test(l));
    assert.deepEqual(lines.slice(at + 1, at + 3), [
      "    ! models.verify.ui is unused: exec.verify is flagged and a UI task is",
      "      verified only when flagged",
    ]);
    assert.ok(lines.every((l) => [...l].length <= 80));
    assert.equal(plain.lanes().models.warning, undefined, "exec.verify all: the ui model is used");
    assert.equal(noFlagged.lanes().models.warning, undefined, "a flagged UI task takes verify.ui");
  } finally {
    rmSync(warned.root, { recursive: true, force: true });
    rmSync(plain.root, { recursive: true, force: true });
    rmSync(noFlagged.root, { recursive: true, force: true });
  }
});
