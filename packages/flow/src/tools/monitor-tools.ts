// Monitor tools — the thin MCP adapters over RunService for the run lifecycle + event stream (the
// `run_*` and `event_*` family, AC8/AC9). Mirrors @agentry/memory's tools/*: the SDK validates the
// zod raw shape, the handler calls the service, and the service's typed outcome maps to ok(payload)
// or err(builder(...)). Envelope prose lives in tools/errors.ts, never built here.
//
// `run` is REQUIRED on every tool except `run_start`, which MINTS it (ADR-005 NO branch — the explicit
// run handle the conductor threads everywhere). No tool resolves an ambient run.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService } from "../application/run-service.js";
import type { FlowServices } from "../index.js";
import { guard } from "./adapter.js";
import { badInput } from "./errors.js";
import { err, ok } from "./result.js";

export function registerMonitorTools(server: McpServer, ctx: FlowServices): void {
  const service = new RunService(ctx);

  server.registerTool(
    "run_start",
    {
      description:
        "The run front door: mint <run> (when absent) and return the explicit run handle the conductor threads into every later FLOW call. Creates .agentry/work/<run>/ + an initial spec.md scaffold; writes the session pointer only when session_id is passed.",
      inputSchema: {
        run: z.string().optional(),
        session_id: z.string().optional(),
        goal: z.string().optional(),
      },
    },
    guard(async (args) => ok(service.start(args))),
  );

  server.registerTool(
    "run_get",
    {
      description: "Read a run's live state (the agent roster + states). Returns { run, state }.",
      inputSchema: { run: z.string() },
    },
    guard(async (args) => ok(service.get(args.run))),
  );

  server.registerTool(
    "run_status",
    {
      description:
        "Read-time run health: a per-status task summary + backstopDisagreements — the hook subagent boundaries with no matching FLOW node line (a skipped FLOW call, AC9). Flags, never blocks (ADR-003).",
      inputSchema: { run: z.string() },
    },
    guard(async (args) => ok(service.status(args.run))),
  );

  server.registerTool(
    "event_emit",
    {
      description:
        "Append one conductor lifecycle line to events.jsonl (AC8). `type` must be a closed FlowEvent (routing-decision | gate | node-enter | node-done); `data` carries the type-specific fields. An out-of-union type is rejected.",
      inputSchema: {
        run: z.string(),
        type: z.string(),
        data: z.record(z.unknown()).optional(),
      },
    },
    guard(async (args) => {
      // Compose the wire shape the closed FlowEvent union validates: { ts, type, ...data }. The caller
      // never supplies `ts` — it is stamped here so every line carries a server clock.
      const event = { ts: new Date().toISOString(), type: args.type, ...(args.data ?? {}) };
      const outcome = service.emit(args.run, event);
      if (outcome.ok) return ok({ ok: true });
      return err(badInput(outcome.field, outcome.rule));
    }),
  );

  server.registerTool(
    "event_tail",
    {
      description:
        "Read the typed FLOW events from events.jsonl (optionally only those at/after `since`, an ISO timestamp). Parses both line shapes and filters empty-agent main-session lines; returns { events: FlowEvent[] }.",
      inputSchema: { run: z.string(), since: z.string().optional() },
    },
    guard(async (args) => ok(service.tail(args.run, args.since))),
  );
}
