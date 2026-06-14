// Episode + stats tools — thin MCP adapters over MemoryService.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EpisodeInput, MemoryService } from "../application/memory-service.js";
import { ok } from "./result.js";

export function registerEpisodeTools(server: McpServer, service: MemoryService): void {
  server.registerTool(
    "episode_write",
    {
      description: "Record a structured episode (task · shape · outcome · retries · lesson · used_memories) — the episodic layer / continue-context fuel.",
      inputSchema: {
        task: z.string(),
        shape: z.string(),
        outcome: z.string(),
        retries: z.number().int().nonnegative().optional(),
        lesson: z.string().optional(),
        usedMemories: z.array(z.string()).optional(),
        recallMisses: z.array(z.string()).optional(),
        repoId: z.string().optional(),
      },
    },
    async (args) => ok(service.episodeWrite(args as EpisodeInput)),
  );

  server.registerTool(
    "memory_stats",
    {
      description: "Aggregate counts across layers — facts/episodes, active/superseded, undistilled-episode debt, by type.",
      inputSchema: {},
    },
    async () => ok(service.stats()),
  );
}
