// Tests for the lane tools end to end: setup registers the lane pair beside the board and mem pairs,
// `agentry_lane`'s reads render exactly the bare CLI's own bytes (the conductor prompt row and the
// vendored-CLI staleness row included), its sweep is the plan only and writes nothing, a missing
// `show` id is the CLI's own verbatim refusal, and `agentry_lane_drive` travels its verbs to the bare
// CLI byte for byte — a refusal verbatim, `spike`'s run state, and `exec start`'s ledger at the same
// commit. Offline, against temp copies of the plugin's synthetic board and a composed lane repo.
// One concern per module here: the lane group.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeSpec } from "../../../plugin/scripts/test/spec-files.mjs";
import { NAMESPACE, NAMESPACE_DESCRIPTION, Plugin } from "../index.js";
import { laneDrive, laneRead } from "../src/tools/lane.mjs";
import { fixtureCleanup, git, gitEnv, mkBoard } from "./fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "..", "vendor", "scripts");
const LANE = join(VENDOR, "lane.mjs");
const CLI_DIR = join(VENDOR, "lib", "lane", "cli");
const SAY = await import(new URL("../vendor/scripts/lib/cli/help.mjs", import.meta.url));
const EXEC = await import(new URL("../vendor/scripts/lib/lane/cli/exec.mjs", import.meta.url));

const temp = [];
after(() => {
  fixtureCleanup();
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

// The one environment every call in this file runs under, in-process or spawned: a scrubbed git env
// (no developer hooks or signing), an empty HOME and global store (no user memory), no color — so a
// fixture never sees the developer's machine, whichever way the CLI was reached.
const home = realpathSync(mkdtempSync(join(tmpdir(), "agentry-opencode-lane-home-")));
temp.push(home);
const FIXTURE_ENV = {
  ...gitEnv,
  HOME: home,
  AGENTRY_GLOBAL_DIR: join(home, "global"),
  NO_COLOR: "1",
};
const ENV_KEYS = [
  "HOME",
  "AGENTRY_GLOBAL_DIR",
  "NO_COLOR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

/** Swap the fixture env into place around an in-process call (a memory-less route call), then restore. */
async function withFixtureEnv(run) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, FIXTURE_ENV);
  try {
    return await run();
  } finally {
    for (const [k, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  }
}

/** The bare vendored lane CLI: one subprocess, the same environment the in-process route calls get. */
function bareCLI(...args) {
  return spawnSync("node", [LANE, ...args], { encoding: "utf8", env: FIXTURE_ENV });
}

// `.agentry/bin/.agentry-version`, the stamp the vendored-CLI staleness row reads (OP2-3's reader).
function stamp(root, version) {
  mkdirSync(join(root, ".agentry", "bin"), { recursive: true });
  writeFileSync(join(root, ".agentry", "bin", ".agentry-version"), `${version}\n`);
}

// The exec-repo fixture `exec-cli.test.mjs` composes: a git repo on main with the process files and
// the board committed, T1 todo. One repo, copied whole (its .git included) before either run touches
// a ledger, is how the drive probe and the bare CLI start at "the same commit".
const SPEC = {
  version: 1,
  name: "Exec",
  root: "plan",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
    },
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
        sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
      },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
      contract: { blocks: ["TASKS.md"] },
    },
  },
  rules: [{ rule: "ids-unique" }, { rule: "status-known" }],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: { status: "status", verdict: "verdict", commit: "commit" },
  },
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "test -f out.txt"] }] },
};
const BOARD_MD = `# Exec

## Sprints

| Sprint | Status |
| ------ | ------ |
| S1     | doing  |

## Tasks

| Task | Sprint | Status | Verdict | Commit |
| ---- | ------ | ------ | ------- | ------ |
| T1   | S1     | todo   |         |        |
`;
const TASKS_MD = `# Tasks

- **T1** (S1): owns \`out.txt\`. Accept: out.txt exists.
`;
function execRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentry-opencode-lane-")));
  temp.push(root);
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  writeSpec(join(root, ".agentry"), SPEC);
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "BOARD.md"), BOARD_MD);
  writeFileSync(join(root, "plan", "TASKS.md"), TASKS_MD);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "plan: the board, the tasks, the spec");
  writeFileSync(join(root, ".gitignore"), ".agentry/run/\n.agentry/config.json\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "ignore the run dir");
  return root;
}
const copyOf = (root) => {
  const to = realpathSync(mkdtempSync(join(tmpdir(), "agentry-opencode-lane-copy-")));
  temp.push(to);
  rmSync(to, { recursive: true, force: true });
  cpSync(root, to, { recursive: true });
  return to;
};

// A path→bytes map of EVERY file, unlike fixture.mjs's snapshot (which skips `.agentry`): a write
// under the run dir counts as a write here.
function fullSnapshot(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(file);
      else files[file] = readFileSync(file, "utf8");
    }
  };
  walk(root);
  return files;
}

// The run's own variance between two `exec start`s at the same commit is the wall clock and the
// repo's location; everything else must survive byte for byte.
const normalize = (bytes, root) =>
  bytes
    .split(root)
    .join("<ROOT>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]{8,}Z?/g, "<TIME>");
// ...and the same for a whole snapshot, so two copies' file maps compare.
const normSnap = (root) =>
  Object.fromEntries(
    Object.entries(fullSnapshot(root)).map(([path, bytes]) => [
      normalize(path, root),
      normalize(bytes, root),
    ]),
  );

test("setup registers the lane pair beside the board and mem pairs, namespaced, typed reads", async () => {
  const added = [];
  const namespaced = [];
  await Plugin.setup({
    tool: {
      transform: async (register) => {
        const editor = {
          namespace: (ns) => namespaced.push(ns),
          add: (tool) => added.push(tool),
        };
        await register(editor);
      },
    },
  });
  assert.deepEqual(namespaced, [{ name: "agentry", description: NAMESPACE_DESCRIPTION }]);
  assert.deepEqual(
    added.map(({ name }) => name),
    [
      "agentry_board",
      "agentry_board_write",
      "agentry_lane",
      "agentry_lane_drive",
      "agentry_mem",
      "agentry_mem_write",
    ],
  );
  for (const tool of added) {
    assert.equal(tool.options.namespace, NAMESPACE);
    assert.equal(tool.options.codemode, true);
  }
  assert.deepEqual(added[2].input.properties.verb.enum, ["session", "sweep", "show"]);
  assert.deepEqual(added[3].input.properties.verb.enum, [
    "exec",
    "merge",
    "sweep",
    "note",
    "spike",
    "session",
  ]);
});

test("a session start through the tool is the bare CLI's own bytes, in text and --json", async () => {
  const a = mkBoard("table-board");
  const b = copyOf(a);
  const text = await withFixtureEnv(() => laneRead.execute({ verb: "session", root: a }));
  const json = await withFixtureEnv(() =>
    laneRead.execute({ verb: "session", json: true, root: a }),
  );
  assert.match(text.content[0].text, /^Sample · session start · mode none set\nconductor prompt: /);
  assert.equal(
    bareCLI("session", "start", "--root", b).stdout,
    `${text.content[0].text}\n`,
    "text: the tool output must be the CLI's own bytes",
  );
  assert.equal(
    bareCLI("session", "start", "--json", "--root", copyOf(a)).stdout,
    `${json.content[0].text}\n`,
    "json: the tool output must be the CLI's own bytes",
  );
  assert.doesNotMatch(text.content[0].text, /^! vendored CLI: /m, "no stamp, no staleness row");
});

test("a planted stale stamp adds the vendored-CLI row, exactly the bare CLI's row", async () => {
  const a = mkBoard("table-board");
  stamp(a, "0.3.0");
  const b = copyOf(a);
  stamp(b, "0.3.0");
  const text = await withFixtureEnv(() => laneRead.execute({ verb: "session", root: a }));
  const cli = bareCLI("session", "start", "--root", b).stdout;
  assert.equal(cli, `${text.content[0].text}\n`);
  const rows = text.content[0].text.split("\n").filter((l) => l.startsWith("! vendored CLI: "));
  assert.equal(rows.length, 1);
  assert.match(rows[0], / → agentry init --host opencode --vendor --apply$/);
  assert.match(
    text.content[0].text,
    /conductor prompt: [^\n]+\n! vendored CLI: /,
    "the row sits after the prompt row",
  );
});

test("a stamp the running package equals is silent; one behind says newer against the package's own version", async () => {
  // The vendored copy under this package carries no plugin manifest: the running build's version is
  // the package's own package.json — so a stamp equal to it prints nothing, and one behind names it
  // as the `current` the row compares against (never "unknown", never a path past the package root).
  const { version } = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  assert.ok(version, "the package carries a version");
  const equal = mkBoard("table-board");
  stamp(equal, version);
  const silentTxt = (
    await withFixtureEnv(() => laneRead.execute({ verb: "session", json: true, root: equal }))
  ).content[0].text;
  assert.equal(JSON.parse(silentTxt).vendoredCLI, null, "current stamp: silent, no row");

  const behind = copyOf(equal);
  stamp(behind, "0.3.0");
  const data = JSON.parse(
    (await withFixtureEnv(() => laneRead.execute({ verb: "session", json: true, root: behind })))
      .content[0].text,
  ).vendoredCLI;
  assert.deepEqual(data, {
    stamp: "0.3.0",
    current: version,
    word: "newer",
    set: "agentry init --host opencode --vendor --apply",
  });
});

test("sweep through the read tool is the plan only: the CLI's preview, and nothing written", async () => {
  const root = execRepo();
  const before = fullSnapshot(root);
  const { content } = await withFixtureEnv(() => laneRead.execute({ verb: "sweep", root }));
  assert.match(content[0].text, /^sweep \(preview: nothing changed; add --apply to act\)/);
  assert.deepEqual(fullSnapshot(root), before, "the plan wrote nothing, under .agentry included");
});

test("show without an id is the CLI's own exit-2 line, verbatim", async () => {
  const [, steps] = /exec <([^>]+)> <id>/.exec(EXEC.help.usage);
  await assert.rejects(
    () => withFixtureEnv(() => laneRead.execute({ verb: "show", root: execRepo() })),
    (error) => {
      assert.equal(
        error.message,
        SAY.say("lane exec", `needs <${steps}> <id>`, "lane exec --help"),
      );
      return true;
    },
  );
});

test("a drive exec step travels args and flags as whole tokens: a real CLI refusal, excerpt-anchored", async () => {
  const a = execRepo();
  const b = copyOf(a);
  // T9 is on no contract block: the CLI refuses before any file changes, so both ways reach the same exit 2.
  const cli = bareCLI("exec", "start", "T9", "--root", b);
  assert.equal(cli.status, 2, cli.stderr);
  await assert.rejects(
    () =>
      withFixtureEnv(() => laneDrive.execute({ verb: "exec", words: ["start", "T9"], root: a })),
    (error) => {
      assert.equal(error.message, cli.stderr.slice(0, -1), "the CLI's own ✗ line(s), verbatim");
      return true;
    },
  );
  assert.deepEqual(normSnap(a), normSnap(b), "a refusal wrote nothing, either way");
});

test("a drive spike files the run state exactly as the bare CLI does (a real write, one step)", async () => {
  const a = execRepo();
  const b = copyOf(a);
  for (const root of [a, b]) git(root, "worktree", "add", "-q", "-b", "x1", join(root, "wt"));
  const { content } = await withFixtureEnv(() =>
    laneDrive.execute({ verb: "spike", words: ["x1", "--for", "T1"], root: a }),
  );
  assert.match(content[0].text, /x1/, "the spike filed, as the CLI prints it");
  assert.equal(bareCLI("spike", "x1", "--for", "T1", "--root", b).status, 0);
  const viaTool = readFileSync(join(a, ".agentry", "run", "spikes.json"), "utf8");
  const viaCli = readFileSync(join(b, ".agentry", "run", "spikes.json"), "utf8");
  assert.equal(normalize(viaTool, a), normalize(viaCli, b), "<TIME>/<ROOT> are the run's alone");
});

test("a drive exec start runs the CLI's one step and writes the ledger the bare CLI writes", async () => {
  const a = execRepo();
  const b = copyOf(a);
  const { content } = await withFixtureEnv(() =>
    laneDrive.execute({ verb: "exec", words: ["start", "T1"], root: a }),
  );
  assert.match(content[0].text, /report T1/, "start prints the pending step");
  const [, brief] = /\bbrief: (\S+)/.exec(content[0].text) ?? [];
  assert.ok(brief && existsSync(brief), "start prints the brief (the parent dirs exist)");
  const started = bareCLI("exec", "start", "T1", "--root", b);
  assert.equal(started.status, 0, started.stderr);
  const viaTool = readFileSync(join(a, ".agentry", "run", "process", "ledger", "T1.json"), "utf8");
  const viaCli = readFileSync(join(b, ".agentry", "run", "process", "ledger", "T1.json"), "utf8");
  assert.equal(normalize(viaTool, a), normalize(viaCli, b), "<TIME>/<ROOT> are the run's alone");
});

test("a drive session close runs the CLI's close round; its ledgers read back through the read tool", async () => {
  const a = execRepo();
  const b = copyOf(a);
  // The lane both ways over the same commit: T1 goes todo → building, the state the close round
  // reports and `exec show` reads back.
  const started = await withFixtureEnv(() =>
    laneDrive.execute({ verb: "exec", words: ["start", "T1"], root: a }),
  );
  assert.match(started.content[0].text, /report T1/, "start puts T1 mid-round");
  const viaCli = bareCLI("exec", "start", "T1", "--root", b);
  assert.equal(viaCli.status, 0, viaCli.stderr);

  // close travels only through the drive tool's words (the read tool's session is start-only).
  const closeText = (
    await withFixtureEnv(() => laneDrive.execute({ verb: "session", words: ["close"], root: a }))
  ).content[0].text;
  const viaClose = bareCLI("session", "close", "--root", b);
  assert.equal(viaClose.status, 0, viaClose.stderr);
  const closed = JSON.parse(closeText);
  assert.deepEqual(
    Object.fromEntries(
      ["drafts", "fixPlan", "ledgers", "cleanable", "strays", "leftAlone", "episodesPending"].map(
        (key) => [key, closed[key]],
      ),
    ),
    Object.fromEntries(
      ["drafts", "fixPlan", "ledgers", "cleanable", "strays", "leftAlone", "episodesPending"].map(
        (key) => [key, JSON.parse(viaClose.stdout)[key]],
      ),
    ),
    "the CLI's own close round, run state but the disk's own alone",
  );
  assert.deepEqual(closed.ledgers, [{ id: "T1", state: "building", next: "build" }]);

  // The state the close round named reads back through the read tool, the bare CLI's own bytes.
  const shown = await withFixtureEnv(() => laneRead.execute({ verb: "show", id: "T1", root: a }));
  const viaShow = bareCLI("exec", "show", "T1", "--root", b);
  assert.equal(viaShow.status, 0, viaShow.stderr);
  assert.equal(
    normalize(shown.content[0].text, a),
    normalize(viaShow.stdout.trimEnd(), b),
    "the CLI's own show, the repos' locations the run's alone",
  );
  assert.match(shown.content[0].text, /T1 · show → build \(building\)/);
});

test("an unknown verb is the CLI's refusal with the help-steer line, verbatim", async () => {
  const subs = readdirSync(CLI_DIR).map((f) => f.replace(/\.mjs$/, ""));
  await assert.rejects(
    () => withFixtureEnv(() => laneDrive.execute({ verb: "bogus" })),
    (error) => {
      assert.equal(
        error.message,
        SAY.say(
          "lane",
          `unknown subcommand "bogus" (subcommands: ${subs.join(", ")})`,
          "lane --help",
        ),
      );
      return true;
    },
  );
});
