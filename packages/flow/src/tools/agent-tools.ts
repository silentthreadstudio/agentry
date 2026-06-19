// Agent tools — thin zod adapters over AgentService (the Agents family, spec §3.1). FLOW *records*
// agent assignment + live state; it does NOT dispatch (the native Agent tool dispatches). Each tool
// takes `run` as a REQUIRED arg (ADR-005 NO branch — no ambient run); the run-state json lives under
// `runDir(ctx.cwd, run)` (the `RunStore` port asserts that segment on every read/write).
//
// Input is shape-validated by the SDK against the zod raw shape, then handed to the service; the
// service's typed outcome is switched → ok(payload) / err(builder(...)). Envelope prose lives in
// tools/errors.ts, never built here. `guard()` maps an unexpected throw to the `internal` envelope.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FlowServices } from "../index.js";
import { AgentService } from "../application/agent-service.js";
import { AgentState } from "../domain/status.js";
import { guard } from "./adapter.js";
import { badInput } from "./errors.js";
import { err, ok } from "./result.js";

export function registerAgentTools(server: McpServer, ctx: FlowServices): void {
  const service = new AgentService(ctx.runs);

  server.registerTool(
    "agent_state",
    {
      description:
        "Record an agent's live state against the run (working|blocked|done). FLOW records state; it does NOT dispatch (the native Agent tool dispatches). 'blocked' is an AGENT state, not a task status (ADR-004).",
      inputSchema: {
        run: z.string(),
        agent: z.string(),
        state: AgentState,
      },
    },
    guard(async (args) => {
      const outcome = service.setState(args.run, args.agent, args.state);
      if (outcome.ok) return ok({ agent: outcome.agent, state: outcome.state });
      return err(badInput(outcome.field, outcome.rule));
    }),
  );

  server.registerTool(
    "agent_roster",
    {
      description:
        "The current agent roster for the run: each agent with its live state and assigned task (if any).",
      inputSchema: {
        run: z.string(),
      },
    },
    guard(async (args) => ok({ agents: service.listRoster(args.run) })),
  );
}
