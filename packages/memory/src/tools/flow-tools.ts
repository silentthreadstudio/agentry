// Flow tools — distill + consolidate. PROPOSE-only: they return drafts/proposals; the conductor
// writes facts (through the bar) and gates skill promotions with the user.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../application/memory-service.js";
import { consolidate, distill } from "../application/flows.js";
import { ok } from "./result.js";

export function registerFlowTools(server: McpServer, service: MemoryService): void {
  server.registerTool(
    "memory_distill",
    {
      description:
        "Two-mode. mode:'list' returns undistilled episodes clustered with draft facts (provenance-linked). mode:'stamp' marks the given episode ids distilled.",
      inputSchema: {
        mode: z.enum(["list", "stamp"]),
        episodeIds: z.array(z.string()).optional(),
      },
    },
    async (args) =>
      args.mode === "stamp"
        ? ok(service.stampDistilled(args.episodeIds ?? []))
        : ok({ clusters: distill(service.undistilledEpisodes()) }),
  );

  server.registerTool(
    "memory_consolidate",
    {
      description:
        "Cluster recurring facts and PROPOSE skill promotions (never installs — skills are human-gated). Returns proposals with provenance.",
      inputSchema: {
        minRecurrence: z.number().int().positive().optional(),
        minUsefulness: z.number().nonnegative().optional(),
      },
    },
    async (args) =>
      ok({ proposals: consolidate(service.activeFacts(), args.minRecurrence, args.minUsefulness) }),
  );
}
