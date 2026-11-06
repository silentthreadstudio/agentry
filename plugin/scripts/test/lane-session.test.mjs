// The vendored-CLI line of `lane session start`: when the MAIN checkout's vendored command stamp is
// behind the running plugin, start prints one `!` advisory line after the conductor prompt naming the
// refresh command, silent when the stamp is current or absent; --json carries the same reader's parts.
// The stamp lives in the main checkout, so a lane worktree sees it too — and never imagines its own.
// Run: node --test plugin/scripts/test/lane-session.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { builtBranch, boardRepo } from "./drift-repo.mjs";
import { gitEnv } from "./git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, "..", "board.mjs");
const LANE = join(HERE, "..", "lane.mjs");
const PLUGIN = join(HERE, "..", "..");
const STAMP = ".agentry/bin/.agentry-version";
const SET = "agentry init --host opencode --vendor --apply";

const home = mkdtempSync(join(tmpdir(), "lane-session-home-"));
const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});

function fresh() {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  return repo.root;
}
// The fresh fixtures do not have the bin directory the stamp lives in.
function stamp(root, version) {
  mkdirSync(dirname(join(root, STAMP)), { recursive: true });
  writeFileSync(join(root, STAMP), `${version}\n`);
}

const session = (root, ...args) =>
  spawnSync("node", [LANE, "session", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });
const explain = (root, ...args) =>
  spawnSync("node", [BOARD, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

const rows = (out) => out.split("\n").filter((l) => /^! vendored CLI: /.test(l));
// The running plugin's version, the `current` the row says.
const pluginVersion = () =>
  JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version;

test("a stamp behind the plugin prints one advisory line after the prompt, with the refresh command", () => {
  const root = fresh();
  stamp(root, "0.3.0");
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split("\n");
  const at = lines.findIndex((l) => l.startsWith("conductor prompt:"));
  assert.deepEqual(lines.slice(at + 1, at + 2), [
    `! vendored CLI: 0.3.0 (plugin: ${pluginVersion()}, newer) → ${SET}`,
  ]);
  assert.equal(rows(res.stdout).length, 1, "exactly one advisory line");
});

test("a stamp the running plugin cannot compare says differs, and its parts land in --json", () => {
  const root = fresh();
  stamp(root, "unknown");
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(rows(res.stdout), [
    `! vendored CLI: unknown (plugin: ${pluginVersion()}, differs) → ${SET}`,
  ]);
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.deepEqual(data.vendoredCLI, {
    stamp: "unknown",
    current: pluginVersion(),
    word: "differs",
    set: SET,
  });
});

test("a stamp current, or none at all, is silent: no line and a null vendoredCLI", () => {
  const current = fresh();
  stamp(current, pluginVersion());
  assert.deepEqual(rows(session(current, "start").stdout), []);
  assert.equal(JSON.parse(session(current, "start", "--json").stdout).vendoredCLI, null);

  const absent = fresh();
  assert.deepEqual(rows(session(absent, "start").stdout), []);
  assert.equal(JSON.parse(session(absent, "start", "--json").stdout).vendoredCLI, null);
});

test("the stamp relative to the run's root: a worktree reads the MAIN checkout's, and imagines no phantom of its own", () => {
  const main = fresh();
  const worktree = builtBranch(main, "T1");
  stamp(main, "0.3.0");
  const res = session(worktree.path, "start");
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(rows(res.stdout), [
    `! vendored CLI: 0.3.0 (plugin: ${pluginVersion()}, newer) → ${SET}`,
  ]);

  // The stamp only in one lane worktree's .agentry: start reads the main checkout's, so it stays
  // silent — no worktree stamp is imagined, and the worktree itself sees none of its own.
  const elsewhere = fresh();
  stamp(builtBranch(elsewhere, "T2").path, "0.3.0");
  assert.deepEqual(rows(session(elsewhere, "start").stdout), []);
  assert.deepEqual(rows(session(builtBranch(elsewhere, "T3").path, "start").stdout), []);
});

test("the advisory line counts toward the 40-line budget but its set step is never cut", () => {
  const root = fresh();
  const long = "0.3.0-alpha.9999+a-build-id.long-enough.to.push.past.any.eighty.column.line";
  stamp(root, long);
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split("\n");
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.deepEqual(rows(res.stdout), [
    `! vendored CLI: ${long} (plugin: ${pluginVersion()}, newer) → ${SET}`,
  ]);
});

test("the printed value and set are exactly what board explain's vendored row says, in one fixture", () => {
  const root = fresh();
  stamp(root, "0.3.0");
  const [, value, set] =
    /^! vendored CLI: (.*) → (.*)$/.exec(rows(session(root, "start").stdout)[0]) ?? [];
  // The same reader, read back its two ways: the row of explain --json, and the plain explain text.
  const row = JSON.parse(explain(root, "explain", "--json").stdout).lanes.find(
    (l) => l.lane === "vendored CLI",
  );
  assert.ok(row, "explain shows the same row");
  assert.equal(value, row.value);
  assert.equal(set, row.set);
  const text = explain(root, "explain").stdout.split("\n");
  const at = text.findIndex((l) => /^✗ +vendored CLI /.test(l));
  assert.ok(at >= 0, text.join("\n"));
  const [, plainValue, plainSet] = /^✗ +vendored CLI  +(.*)\n +set: (.*)$/.exec(
    text.slice(at, at + 2).join("\n"),
  );
  assert.equal(plainValue, row.value);
  assert.equal(plainSet, row.set);
});
