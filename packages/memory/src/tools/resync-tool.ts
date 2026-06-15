// Resync tool — the manual force-rebuild escape hatch (ADR-001 §b). A thin adapter mirroring the
// established pattern (flow-tools.ts): force the index back into sync with the file-store (truth) and
// return before/after counts. Wrapped in guard() so an unexpected throw becomes the `internal` envelope.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryService } from "../application/memory-service.js";
import { guard } from "./adapter.js";
import { ok } from "./result.js";

export function registerResyncTool(server: McpServer, service: MemoryService): void {
  server.registerTool(
    "memory_resync",
    {
      description:
        "Force-rebuild the derived index from the file-store (truth) — use when another process wrote memories this session can't see. Returns before/after fact+episode counts.",
      inputSchema: {},
    },
    guard(async () => ok(service.resync())),
  );
}
