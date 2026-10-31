// Tests for lib/process/default-agent.mjs and `board default-agent` (F23): the merge-write into
// `<root>/.claude/settings.json`, the refusals, the static check and the live check's reading of a
// stream-json run (a fake `claude` here; the real one only runs when a person asks for it).
// Run: node --test plugin/scripts/test/default-agent.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
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
import { run } from "../lib/process/cli/default-agent.mjs";
import { AGENT, LIVE_ARGS, PLUGIN_ROOT, resolvedFrom } from "../lib/process/default-agent.mjs";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentry-agent-")));
  temps.push(dir);
  return dir;
};

/** A project root, with `.claude/settings.json` holding `settings` when given, and a fake plugin. */
function project(settings) {
  const root = scratch();
  if (settings !== undefined) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), settings);
  }
  const pluginRoot = join(scratch(), "plugin");
  mkdirSync(join(pluginRoot, "agents"), { recursive: true });
  writeFileSync(join(pluginRoot, "agents", "conductor.md"), "---\nname: conductor\n---\n");
  return { root, pluginRoot };
}
const settingsOf = (root) => readFileSync(join(root, ".claude", "settings.json"), "utf8");
function call(argv, ctx) {
  const res = run(argv, ctx);
  return { ...res, json: res.exit === 2 ? null : JSON.parse(res.out) };
}

test("--write creates the settings file when there is none", () => {
  const ctx = project();
  const { exit, json } = call(["--write"], ctx);
  assert.equal(exit, 0);
  assert.deepEqual(json, {
    settings: join(ctx.root, ".claude", "settings.json"),
    current: null,
    wrote: true,
    resolved: "unchecked",
    how: json.how,
  });
  assert.equal(settingsOf(ctx.root), `{\n  "agent": "${AGENT}"\n}\n`);
});

test("--write keeps every other key in place and writes 2-space JSON", () => {
  const ctx = project('{"model":"opus","permissions":{"allow":["Bash(ls:*)"]},"env":{"A":"1"}}');
  const { exit, json } = call(["--write"], ctx);
  assert.equal(exit, 0);
  assert.equal(json.wrote, true);
  assert.equal(
    settingsOf(ctx.root),
    [
      "{",
      '  "model": "opus",',
      '  "permissions": {',
      '    "allow": [',
      '      "Bash(ls:*)"',
      "    ]",
      "  },",
      '  "env": {',
      '    "A": "1"',
      "  },",
      `  "agent": "${AGENT}"`,
      "}",
      "",
    ].join("\n"),
  );
});

test("a different agent is reported, and replaced in its place only with --write", () => {
  const before = '{\n  "agent": "someone:else",\n  "model": "opus"\n}\n';
  const ctx = project(before);
  const report = call([], ctx);
  assert.equal(report.exit, 0);
  assert.equal(report.json.current, "someone:else");
  assert.equal(report.json.wrote, false);
  assert.equal(settingsOf(ctx.root), before);

  const written = call(["--write"], ctx);
  assert.equal(written.json.current, "someone:else");
  assert.equal(written.json.wrote, true);
  assert.equal(settingsOf(ctx.root), `{\n  "agent": "${AGENT}",\n  "model": "opus"\n}\n`);
});

test("--write leaves a file that already names the agent byte for byte", () => {
  const before = `{    "agent":"${AGENT}" }`;
  const ctx = project(before);
  const { json } = call(["--write"], ctx);
  assert.equal(json.wrote, false);
  assert.equal(json.current, AGENT);
  assert.equal(settingsOf(ctx.root), before);
});

for (const [name, text] of [
  ["unparseable JSON", '{ "model": "opus", }'],
  ["an empty file", ""],
  ["a JSON array", '["agent"]'],
  ["JSON null", "null"],
]) {
  test(`${name} is refused with exit 2 and never overwritten`, () => {
    const ctx = project(text);
    for (const argv of [[], ["--write"], ["--write", "--verify"]]) {
      const res = run(argv, ctx);
      assert.equal(res.exit, 2, argv.join(" "));
      assert.match(res.out, /settings\.json: .*not changed/);
      assert.equal(settingsOf(ctx.root), text);
    }
  });
}

test("a settings file linked to the plugin's own settings.json is never written", () => {
  const ctx = project();
  const own = join(ctx.pluginRoot, "settings.json");
  writeFileSync(own, "{}\n");
  mkdirSync(join(ctx.root, ".claude"));
  symlinkSync(own, join(ctx.root, ".claude", "settings.json"));
  const res = run(["--write"], ctx);
  assert.equal(res.exit, 2);
  assert.match(res.out, /plugin's own settings\.json/);
  assert.equal(readFileSync(own, "utf8"), "{}\n");
});

test("a .claude folder linked to the plugin never creates the plugin's settings.json", () => {
  const ctx = project();
  symlinkSync(ctx.pluginRoot, join(ctx.root, ".claude"));
  const res = run(["--write"], ctx);
  assert.equal(res.exit, 2);
  assert.equal(existsSync(join(ctx.pluginRoot, "settings.json")), false);
});

test("a broken settings symlink is refused, so the write never lands where it points", () => {
  const ctx = project();
  const own = join(ctx.pluginRoot, "settings.json");
  mkdirSync(join(ctx.root, ".claude"));
  symlinkSync(own, join(ctx.root, ".claude", "settings.json"));
  const res = run(["--write"], ctx);
  assert.equal(res.exit, 2);
  assert.match(res.out, /broken symlink/);
  assert.equal(existsSync(own), false);
});

test("a settings file hard-linked to the plugin's own settings.json is never written", () => {
  const ctx = project();
  const own = join(ctx.pluginRoot, "settings.json");
  writeFileSync(own, "{}\n");
  mkdirSync(join(ctx.root, ".claude"));
  linkSync(own, join(ctx.root, ".claude", "settings.json"));
  const res = run(["--write"], ctx);
  assert.equal(res.exit, 2);
  assert.match(res.out, /plugin's own settings\.json/);
  assert.equal(readFileSync(own, "utf8"), "{}\n");
});

test("--verify answers no when settings.local.json sets another agent, which wins", () => {
  const ctx = project(`{"agent":"${AGENT}"}`);
  writeFileSync(join(ctx.root, ".claude", "settings.local.json"), '{"agent":"other"}');
  for (const argv of [["--verify"], ["--verify", "live"]]) {
    const { exit, json } = call(argv, { ...ctx, claude: "/nonexistent/claude" });
    assert.equal(exit, 1);
    assert.equal(json.resolved, "no");
    assert.match(json.how, /settings\.local\.json sets agent "other"/);
  }
});

test("--verify live spends no request when the static check already says no", () => {
  const ctx = project('{"agent":"agentry:conductr"}');
  const { exit, json } = call(["--verify", "live"], { ...ctx, claude: "/nonexistent/claude" });
  assert.equal(exit, 1);
  assert.equal(json.resolved, "no");
  assert.match(json.how, /^static: the name is wrong/);
});

test("--verify (static) answers yes for the exact name and an existing agent file", () => {
  const ctx = project(`{"agent":"${AGENT}"}`);
  const { exit, json } = call(["--verify"], ctx);
  assert.equal(exit, 0);
  assert.equal(json.resolved, "yes");
  assert.match(json.how, /^static: /);
});

test("--write --verify checks the value it just wrote", () => {
  const ctx = project('{"agent":"someone:else"}');
  const { exit, json } = call(["--write", "--verify", "static"], ctx);
  assert.equal(exit, 0);
  assert.equal(json.resolved, "yes");
});

test("--verify (static) answers no, exit 1, for a misspelled name or a missing agent file", () => {
  const misspelled = project('{"agent":"agentry:conductr"}');
  const a = call(["--verify"], misspelled);
  assert.equal(a.exit, 1);
  assert.equal(a.json.resolved, "no");
  assert.match(a.json.how, /name is wrong: agent is "agentry:conductr"/);

  const unset = call(["--verify"], project("{}"));
  assert.equal(unset.json.resolved, "no");
  assert.match(unset.json.how, /agent is unset/);

  const noFile = project(`{"agent":"${AGENT}"}`);
  rmSync(join(noFile.pluginRoot, "agents", "conductor.md"));
  const b = call(["--verify"], noFile);
  assert.equal(b.exit, 1);
  assert.equal(b.json.resolved, "no");
  assert.match(b.json.how, /conductor\.md does not exist/);
});

test("--verify takes only static or live", () => {
  const res = run(["--verify", "remote"], project("{}"));
  assert.equal(res.exit, 2);
  assert.match(res.out, /usage: default-agent/);
});

const init = (fields) => JSON.stringify({ type: "system", subtype: "init", ...fields });
const loaded = {
  agents: ["claude", "Explore", AGENT, "general-purpose"],
  plugins: [{ name: "agentry", path: "/x", source: "agentry@inline" }],
};

test("resolvedFrom: yes when the exact name is in the system/init agents", () => {
  const stream = ["not json", init(loaded), '{"type":"result"}'].join("\n");
  assert.deepEqual(resolvedFrom(stream, AGENT).resolved, "yes");
});

test("resolvedFrom: the agents list shows what is available, so a misspelled setting is no", () => {
  const got = resolvedFrom(init(loaded), "agentry:conductr");
  assert.equal(got.resolved, "no");
  assert.match(got.how, /name is wrong/);
});

test("resolvedFrom: no, plugin not enabled, when agentry is not loaded", () => {
  const got = resolvedFrom(init({ agents: ["claude"], plugins: [] }), AGENT);
  assert.equal(got.resolved, "no");
  assert.match(got.how, /plugin not enabled/);
});

test("resolvedFrom: no, name wrong, when agentry is loaded without the agent", () => {
  const got = resolvedFrom(init({ ...loaded, agents: ["claude"] }), AGENT);
  assert.equal(got.resolved, "no");
  assert.match(got.how, /loaded but has no "conductor" agent/);
});

test("resolvedFrom: unchecked when the run printed no init event", () => {
  assert.equal(resolvedFrom('{"type":"result"}\n', AGENT).resolved, "unchecked");
});

/** A fake `claude` that records its argv and cwd, then prints a system/init event. */
function fakeClaude(fields) {
  const dir = scratch();
  const bin = join(dir, "claude");
  const log = join(dir, "call.json");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
console.log(${JSON.stringify(init(fields))});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, call: () => JSON.parse(readFileSync(log, "utf8")) };
}

test("--verify live runs one `claude -p` in the root and reads its init event", () => {
  const ctx = project(`{"agent":"${AGENT}"}`);
  const claude = fakeClaude(loaded);
  const { exit, json } = call(["--verify", "live"], { ...ctx, claude: claude.bin });
  assert.equal(exit, 0);
  assert.equal(json.resolved, "yes");
  assert.match(json.how, /^live: /);
  assert.deepEqual(claude.call(), { argv: LIVE_ARGS, cwd: ctx.root });
});

test("--verify live answers no, exit 1, when the plugin is not loaded", () => {
  const ctx = project(`{"agent":"${AGENT}"}`);
  const { exit, json } = call(["--verify", "live"], {
    ...ctx,
    claude: fakeClaude({ agents: ["claude"], plugins: [] }).bin,
  });
  assert.equal(exit, 1);
  assert.equal(json.resolved, "no");
  assert.match(json.how, /plugin not enabled/);
});

test("--verify live is unchecked, exit 1, when claude cannot run", () => {
  const ctx = project(`{"agent":"${AGENT}"}`);
  const { exit, json } = call(["--verify", "live"], { ...ctx, claude: join(scratch(), "none") });
  assert.equal(exit, 1);
  assert.equal(json.resolved, "unchecked");
});

test("no live request without --verify live", () => {
  const ctx = project(`{"agent":"${AGENT}"}`);
  const claude = fakeClaude(loaded);
  for (const argv of [[], ["--write"], ["--verify"]]) call(argv, { ...ctx, claude: claude.bin });
  assert.throws(claude.call, /ENOENT/);
});

test("board default-agent runs through the router with no process file", () => {
  const { root } = project();
  const res = spawnSync("node", [BOARD, "default-agent", "--root", root], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).resolved, "unchecked");
  const bad = spawnSync("node", [BOARD, "default-agent", "--force", "--root", root], {
    encoding: "utf8",
  });
  assert.equal(bad.status, 2);
});

test("the shipped conductor agent: the file static verify expects, no tools/model, the pinned commands", () => {
  const text = readFileSync(join(PLUGIN_ROOT, "agents", "conductor.md"), "utf8");
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.match(front, /^name: conductor$/m);
  assert.doesNotMatch(front, /^(tools|model):/m);
  for (const name of [
    "/agentry:start",
    "/agentry:exec",
    "/agentry:merge",
    "/agentry:ask",
    "/agentry:close",
    "/agentry:new decision",
    "board draft add",
  ])
    assert.ok(text.includes(`\`${name}`), name);
});
