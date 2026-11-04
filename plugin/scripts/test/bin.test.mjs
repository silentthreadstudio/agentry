// The `agentry` command (plugin/bin/agentry): it routes to the scripts and keeps their output and exit
// codes; and the next steps the CLIs print name it, but only when `agentry` on PATH is this plugin's bin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { pluginVersion } from "../lib/cli/help.mjs";
import { nextStep, prefix, viaAgentry } from "../lib/cli/invoke.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(PLUGIN, "bin", "agentry");
const SCRIPTS = join(PLUGIN, "scripts");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const agentry = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const script = (name, ...args) =>
  spawnSync(process.execPath, [join(SCRIPTS, name), ...args], { encoding: "utf8" });

// A PATH whose `agentry` is a symlink to the real bin, the way the host puts it there.
function pathWith() {
  const dir = mkdtempSync(join(tmpdir(), "agentry-bin-"));
  temps.push(dir);
  symlinkSync(BIN, join(dir, "agentry"));
  return { PATH: dir };
}

test("--version prints the plugin's version", () => {
  const { version } = JSON.parse(
    readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const run = agentry("--version");
  assert.equal(run.stdout.trim(), pluginVersion());
  assert.ok(run.stdout.startsWith(version));
  assert.equal(run.status, 0);
});

test("--help names the three groups", () => {
  const run = agentry("--help");
  assert.equal(run.status, 0);
  for (const group of ["board", "lane", "draft"])
    assert.match(run.stdout, new RegExp(`agentry ${group}`));
});

test("--help ends with the plugin's version, as every group and subcommand help does", () => {
  const { version } = JSON.parse(
    readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const last = agentry("--help").stdout.trimEnd().split("\n").at(-1);
  assert.equal(last, `agentry plugin ${pluginVersion()}`);
  assert.ok(last.startsWith(`agentry plugin ${version}`));
});

test("board and lane give the scripts' own output and exit codes", () => {
  for (const [group, file] of [
    ["board", "board.mjs"],
    ["lane", "lane.mjs"],
  ]) {
    const via = agentry(group, "--help");
    const direct = script(file, "--help");
    assert.equal(via.stdout, direct.stdout);
    assert.equal(via.status, direct.status);
  }
  const bad = agentry("lane", "nope");
  const direct = script("lane.mjs", "nope");
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr, direct.stderr);
});

test("draft is board draft", () => {
  const via = agentry("draft", "--help");
  const direct = script("board.mjs", "draft", "--help");
  assert.equal(via.stdout, direct.stdout);
  assert.equal(via.status, 0);
});

test("an unknown group exits 2 with one error line pointing at --help", () => {
  const run = agentry("deploy");
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^✗ agentry deploy: .* → agentry --help\n$/);
  assert.equal(run.stdout, "");
});

test("a next step names agentry when it is this plugin's bin on PATH", () => {
  const env = pathWith();
  assert.equal(viaAgentry(env), true);
  assert.equal(prefix("lane", "node x", env), "agentry lane");
  assert.equal(
    nextStep("fix it, then lane merge T-4 --preflight; board status", env),
    "fix it, then agentry lane merge T-4 --preflight; agentry board status",
  );
});

test("a usage error's `lane --help` next step names agentry too", () => {
  assert.equal(
    nextStep("lane --help; board exec --help", pathWith()),
    "agentry lane --help; board exec --help",
  );
});

test("a next step keeps its form when agentry is not on PATH or is another file", () => {
  const empty = mkdtempSync(join(tmpdir(), "agentry-none-"));
  temps.push(empty);
  const other = mkdtempSync(join(tmpdir(), "agentry-other-"));
  temps.push(other);
  const stranger = join(other, "bin");
  mkdirSync(stranger);
  spawnSync("cp", [BIN, join(stranger, "agentry")]);
  for (const env of [{ PATH: empty }, { PATH: stranger }]) {
    assert.equal(viaAgentry(env), false);
    assert.equal(prefix("lane", "node x", env), "node x");
    assert.equal(nextStep("then lane merge T-4", env), "then lane merge T-4");
  }
});

test("nextStep leaves slash commands, prose and labels alone", () => {
  const env = pathWith();
  const text =
    "/agentry:board fix; the board commit; board check: 0 findings; agentry board status";
  assert.equal(nextStep(text, env), text);
});

test("the printed error's next step reads agentry through the real CLI", () => {
  const env = { ...process.env, ...pathWith() };
  const run = spawnSync(process.execPath, [join(SCRIPTS, "board.mjs"), "status", "--nope"], {
    encoding: "utf8",
    env,
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /→ agentry board status --help/);
});

test("with plugin.json unreadable, --version and the --help footer say the version is unknown (R1d-22 N3)", () => {
  // A plugin root holding a copy of the bin and the real scripts, but no .claude-plugin/plugin.json.
  const root = mkdtempSync(join(tmpdir(), "agentry-noversion-"));
  temps.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "agentry"), readFileSync(BIN));
  symlinkSync(SCRIPTS, join(root, "scripts"));
  const run = (arg) =>
    spawnSync(process.execPath, [join(root, "bin", "agentry"), arg], { encoding: "utf8" });
  const version = run("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, "(version unknown)\n");
  assert.equal(
    run("--help").stdout.trimEnd().split("\n").at(-1),
    "agentry plugin (version unknown)",
  );
});
