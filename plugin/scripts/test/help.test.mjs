// Every `board` and `lane` subcommand carries the one help format (lib/cli/help.mjs): a usage line, a
// one-line purpose, its args and flags, its exit codes and an example of itself; and `--help` prints
// it, exit 0, without a process file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { flagsOf, pluginVersion, renderHelp, say } from "../lib/cli/help.mjs";
import { commitFile, git } from "./git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIS = {
  board: join(HERE, "..", "lib", "process", "cli"),
  lane: join(HERE, "..", "lib", "lane", "cli"),
};

for (const [cli, dir] of Object.entries(CLIS))
  for (const file of readdirSync(dir)) {
    const sub = file.replace(/\.mjs$/, "");
    test(`${cli} ${sub}: its help has every part`, async () => {
      const { help } = await import(pathToFileURL(join(dir, file)).href);
      assert.ok(help, "exports help");
      for (const u of [help.usage].flat()) assert.match(u, new RegExp(`^${sub}\\b`));
      assert.match(help.purpose, /^[A-Z].*\.$/, "one sentence");
      assert.ok(!help.purpose.includes("\n"), "one line");
      assert.equal(typeof help.args, "object");
      for (const key of Object.keys(help.flags)) assert.match(key, /^--[a-z-]+( .+)?$/);
      assert.ok(Object.hasOwn(help.exits, 0), "exit 0 is described");
      assert.equal(flagsOf(help)["--json"], false, "takes --json, an output switch");
      for (const code of Object.keys(help.exits)) assert.ok(["0", "1", "2"].includes(code));
      assert.match(help.example, new RegExp(`^${cli} ${sub}\\b`));
      // Every flag the usage line names is one the parser takes.
      const named =
        [help.usage]
          .flat()
          .join(" ")
          .match(/--[a-z-]+/g) ?? [];
      for (const flag of named) assert.ok(Object.hasOwn(flagsOf(help), flag), flag);
    });
  }

test("--help on a sub prints its help and exits 0, with no process file around", () => {
  const empty = tmpdir();
  const res = spawnSync(
    "node",
    [join(HERE, "..", "lane.mjs"), "merge", "--help", "--root", empty],
    {
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^usage: lane merge <id>/);
  assert.match(res.stdout, /\nexits:\n {2}0 {2}done, next printed\n/);
});

test("an error is one line: ✗ what: why → next", () => {
  assert.equal(
    say("board set", "no task T9", "board status"),
    "✗ board set: no task T9 → board status",
  );
  assert.equal(say("board set", "no task T9"), "✗ board set: no task T9");
});

test("--help, on a sub and on the index, ends with the running build's version", () => {
  const running = pluginVersion();
  const { version } = JSON.parse(
    readFileSync(join(HERE, "..", "..", ".claude-plugin", "plugin.json"), "utf8"),
  );
  assert.ok(running.startsWith(version), running);
  for (const args of [["merge", "--help"], ["--help"]]) {
    const res = spawnSync("node", [join(HERE, "..", "lane.mjs"), ...args, "--root", tmpdir()], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trimEnd().split("\n").at(-1), `agentry plugin ${running}`);
  }
});

// --- the running build's version ----------------------------------------------------------

const BIN = join(HERE, "..", "..", "bin", "agentry");
const VERSION = "1.2.0";
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "agentry-version-")));
const MANIFEST = "plugin/.claude-plugin/plugin.json";
// A repo whose `plugin/` holds a manifest at VERSION, bumped in its first commit; `plugin` is the root.
function bumped() {
  const dir = scratch();
  git(dir, "init", "-q", "-b", "main");
  commitFile(dir, MANIFEST, JSON.stringify({ version: VERSION }), "chore: bump to 1.2.0");
  return { dir, plugin: join(dir, "plugin") };
}
const short = (dir) => git(dir, "rev-parse", "--short", "HEAD");

test("agentry --version and the --help footer print the same running build's version", () => {
  const running = pluginVersion();
  const v = spawnSync("node", [BIN, "--version"], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `${running}\n`);
  const h = spawnSync("node", [BIN, "--help"], { encoding: "utf8" });
  assert.equal(h.stdout.trimEnd().split("\n").at(-1), `agentry plugin ${running}`);
});

test("a plugin root that is no git checkout prints plugin.json's version", () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: VERSION }));
    assert.equal(pluginVersion(dir), VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkout at the commit that last changed plugin.json prints the plain version", () => {
  const { dir, plugin } = bumped();
  try {
    commitFile(dir, "plugin/a.txt", "a\n");
    commitFile(dir, MANIFEST, JSON.stringify({ version: VERSION, x: 1 }), "chore: bump again");
    assert.equal(pluginVersion(plugin), VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("past the bump: +n on HEAD's first-parent line and the short HEAD", () => {
  const { dir, plugin } = bumped();
  try {
    commitFile(dir, "plugin/a.txt", "a\n");
    git(dir, "checkout", "-q", "-b", "side");
    commitFile(dir, "plugin/b.txt", "b\n");
    commitFile(dir, "plugin/c.txt", "c\n");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    // a.txt and the merge are on the first-parent line; side's two commits are not.
    assert.equal(pluginVersion(plugin), `${VERSION}+2 (${short(dir)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncommitted changes in the plugin tree append dirty; ones outside it do not", () => {
  const { dir, plugin } = bumped();
  try {
    commitFile(dir, "plugin/a.txt", "a\n");
    writeFileSync(join(dir, "outside.txt"), "x\n");
    assert.equal(pluginVersion(plugin), `${VERSION}+1 (${short(dir)})`);
    writeFileSync(join(plugin, "a.txt"), "changed\n");
    assert.equal(pluginVersion(plugin), `${VERSION}+1 (${short(dir)}) dirty`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plugin root in a git worktree (not the main checkout) counts as a checkout", () => {
  const { dir } = bumped();
  const tree = join(scratch(), "wt");
  try {
    commitFile(dir, "plugin/a.txt", "a\n");
    git(dir, "worktree", "add", "-q", "-b", "lane", tree);
    commitFile(tree, "plugin/b.txt", "b\n");
    assert.equal(pluginVersion(join(tree, "plugin")), `${VERSION}+2 (${short(tree)})`);
  } finally {
    rmSync(dirname(tree), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shallow clone where the bump commit is out of reach prints the plain version", () => {
  const { dir } = bumped();
  const clone = join(scratch(), "clone");
  try {
    commitFile(dir, "plugin/a.txt", "a\n");
    commitFile(dir, "plugin/b.txt", "b\n");
    git(dir, "clone", "-q", "--depth", "2", `file://${dir}`, clone);
    assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true");
    assert.equal(pluginVersion(join(clone, "plugin")), VERSION);
  } finally {
    rmSync(dirname(clone), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git failing prints the plain version", () => {
  const { dir, plugin } = bumped();
  try {
    commitFile(dir, "plugin/a.txt", "a\n");
    const url = pathToFileURL(join(HERE, "..", "lib", "cli", "help.mjs")).href;
    const res = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { pluginVersion } from ${JSON.stringify(url)}; console.log(pluginVersion(process.env.ROOT));`,
      ],
      { encoding: "utf8", env: { ...process.env, ROOT: plugin, GIT_DIR: join(dir, "nowhere") } },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${VERSION}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the example reads `agentry board …` when the bin is on PATH, and keeps its form otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-help-"));
  try {
    symlinkSync(join(HERE, "..", "..", "bin", "agentry"), join(dir, "agentry"));
    const help = { usage: "scan", purpose: "x.", example: "board scan docs --json" };
    assert.match(
      renderHelp("board", "scan", help, { PATH: dir }),
      /\n {2}agentry board scan docs --json\n/,
    );
    assert.match(renderHelp("board", "scan", help, { PATH: "" }), /\n {2}board scan docs --json\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
