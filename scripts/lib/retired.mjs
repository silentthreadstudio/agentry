// retired — the surfaces the plugin no longer ships (the web UI, its run-state MCP server and its channels,
// and the memory MCP server `agentry mem` replaced). An agent told to call a tool that is not there stalls or
// improvises, and a manifest that starts a server
// whose bundle is gone fails at load, so the gate refuses both.
//
// retiredMentions(pluginDir) -> string[]      "<file>: names a removed surface (<pattern>)" each
// missingServerPaths(pluginDir) -> string[]   ".claude-plugin/plugin.json: mcpServers.<name> starts <arg>, which does not exist" each
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const TOOLS = [
  "run_start",
  "run_get",
  "run_status",
  "task_get",
  "task_create",
  "task_list",
  "task_assign",
  "task_status",
  "artifact_write",
  "event_emit",
  "event_tail",
  "agent_state",
  "agent_roster",
  "review_comment",
  "review_list",
  "review_resolve",
  "backlog_add",
  "backlog_claim",
  "backlog_list",
  "backlog_update",
  "channel_reply",
];
export const RETIRED = [
  /workbench/i,
  /mcp__plugin_agentry_flow/,
  /mcp__plugin_agentry_mem__/,
  new RegExp(`\\b(?:${TOOLS.join("|")})\\b`),
];

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );

export function retiredMentions(pluginDir) {
  const problems = [];
  for (const file of files(pluginDir)) {
    const text = readFileSync(file, "utf8");
    for (const re of RETIRED) {
      const hit = re.exec(text);
      if (hit) problems.push(`${relative(pluginDir, file)}: names a removed surface (${hit[0]})`);
    }
  }
  return problems;
}

export function missingServerPaths(pluginDir) {
  const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) return [];
  const servers = JSON.parse(readFileSync(manifest, "utf8")).mcpServers ?? {};
  const problems = [];
  for (const [name, server] of Object.entries(servers)) {
    for (const arg of server?.args ?? []) {
      if (typeof arg !== "string" || !arg.includes("${CLAUDE_PLUGIN_ROOT}")) continue;
      if (!existsSync(arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDir)))
        problems.push(
          `.claude-plugin/plugin.json: mcpServers.${name} starts ${arg}, which does not exist`,
        );
    }
  }
  return problems;
}
