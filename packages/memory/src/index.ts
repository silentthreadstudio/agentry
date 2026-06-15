// @agentry/memory — stdio MCP server entry. Wires the layers: resolve roots → build the in-memory
// index from the file store → register the tools → connect the transport. See doc 07.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryService } from "./application/memory-service.js";
import { SqliteTextIndex } from "./persistence/db-index.js";
import { MarkdownFileStore } from "./persistence/file-store.js";
import { resolveRoots } from "./resolution/roots.js";
import { registerEpisodeTools } from "./tools/episode-tools.js";
import { registerFactTools } from "./tools/fact-tools.js";
import { registerFlowTools } from "./tools/flow-tools.js";
import { registerResyncTool } from "./tools/resync-tool.js";

async function main(): Promise<void> {
  const roots = resolveRoots();
  const service = new MemoryService(new MarkdownFileStore(roots), new SqliteTextIndex(), roots);
  service.load(); // rebuild-on-start from the file store (text = truth)

  const server = new McpServer({ name: "agentry-memory", version: "0.1.0" });
  registerFactTools(server, service);
  registerEpisodeTools(server, service);
  registerFlowTools(server, service);
  registerResyncTool(server, service);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`[mem] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
