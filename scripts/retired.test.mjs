// Tests for scripts/lib/retired.mjs: the gate's guard against the removed web UI, its run-state MCP server,
// its tools and channels coming back into the plugin payload, on synthetic plugin dirs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { missingServerPaths, retiredMentions } from "./lib/retired.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A plugin dir with one skill whose text is `skill`, and a manifest starting `servers`; mem/index.js exists.
function plugin(skill, servers = { mem: ["${CLAUDE_PLUGIN_ROOT}/mem/index.js"] }) {
  const dir = mkdtempSync(join(tmpdir(), "retired-"));
  temps.push(dir);
  mkdirSync(join(dir, ".claude-plugin"));
  mkdirSync(join(dir, "skills", "reviewing"), { recursive: true });
  mkdirSync(join(dir, "mem"));
  writeFileSync(join(dir, "mem", "index.js"), "export {};\n");
  writeFileSync(join(dir, "skills", "reviewing", "SKILL.md"), skill);
  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, args]) => [name, { command: "node", args }]),
  );
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ mcpServers }));
  return dir;
}

test("retiredMentions is empty for a payload that names none of the removed surfaces", () => {
  assert.deepEqual(retiredMentions(plugin("Review the task file, then report.\n")), []);
});

test("retiredMentions names the UI, the namespaced server prefix and a bare tool name", () => {
  for (const [text, hit] of [
    ["Open the Workbench to review.\n", "Workbench"],
    ["Call mcp__plugin_agentry_flow__task_get.\n", "mcp__plugin_agentry_flow"],
    ["Then call `task_status(run, done)`.\n", "task_status"],
    ["First `run_start(goal)`.\n", "run_start"],
    ["Answer via `channel_reply`.\n", "channel_reply"],
  ])
    assert.deepEqual(retiredMentions(plugin(text)), [
      `skills/reviewing/SKILL.md: names a removed surface (${hit})`,
    ]);
});

test("retiredMentions leaves words that only contain a tool name alone", () => {
  assert.deepEqual(retiredMentions(plugin("Our subtask_status and run_started fields.\n")), []);
});

test("missingServerPaths passes servers whose bundle exists and names one whose bundle is gone", () => {
  assert.deepEqual(missingServerPaths(plugin("x\n")), []);
  const dir = plugin("x\n", {
    mem: ["${CLAUDE_PLUGIN_ROOT}/mem/index.js"],
    flow: ["${CLAUDE_PLUGIN_ROOT}/flow/index.js"],
  });
  assert.deepEqual(missingServerPaths(dir), [
    ".claude-plugin/plugin.json: mcpServers.flow starts ${CLAUDE_PLUGIN_ROOT}/flow/index.js, which does not exist",
  ]);
});
