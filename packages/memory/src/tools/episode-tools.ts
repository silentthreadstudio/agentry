// Episode + stats tools — thin MCP adapters over MemoryService. Wrapped in guard() so an unexpected
// throw becomes the `internal` envelope (AC7). memory_stats surfaces collected read-errors (Q1).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EpisodeInput, MemoryService } from "../application/memory-service.js";
import { guard } from "./adapter.js";
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
    guard(async (args) => ok(service.episodeWrite(args as EpisodeInput))),
  );

  server.registerTool(
    "memory_stats",
    {
      description: "Aggregate counts across layers — facts/episodes, active/superseded, undistilled-episode debt, by type. Surfaces read-errors for any corrupt/unreadable store record.",
      inputSchema: {},
    },
    // stats() already carries readErrors as an additive field (Q1) — surface it on the payload.
    guard(async () => ok(service.stats())),
  );
}
