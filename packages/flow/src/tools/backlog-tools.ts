// Backlog tools — the four MCP adapters over BacklogService (doc 18 §3.3). Thin, like every other tool
// family here: the SDK validates the zod shape, the service owns the semantics, `guard` maps an
// unexpected throw to the `internal` envelope.
//
// `backlog_claim` is the one worth reading twice: it is the ONLY path from intent to a running run, and
// it is pull, not push. Nothing in FLOW or the Workbench starts work on its own — a session asks for the
// next item, and that is what makes autonomy something the user opts into rather than discovers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BacklogService } from "../application/backlog-service.js";
import { BacklogStatus } from "../domain/backlog.js";
import type { BacklogStore, RunStore, TaskStore } from "../domain/ports.js";
import { RunService } from "../application/run-service.js";
import { guard } from "./adapter.js";
import { invalidState, notFound } from "./errors.js";
import { err, ok } from "./result.js";

// The slice of the shared context this family needs. `RunService` is constructed from the same services
// the rest of FLOW uses, so a claimed run is byte-identical to one `run_start` minted.
interface BacklogCtx {
  cwd: string;
  backlog: BacklogStore;
  tasks: TaskStore;
  runs: RunStore;
}

export function registerBacklogTools(server: McpServer, ctx: BacklogCtx): void {
  const runService = new RunService(ctx as never);
  const service = new BacklogService(ctx.backlog, runService, () => new Date().toISOString());

  server.registerTool(
    "backlog_add",
    {
      description:
        "Add an item to this project's backlog — durable intent that has not become a run yet. Use to capture work to do later. Set ready:true to queue it for the conductor instead of parking it.",
      inputSchema: {
        title: z.string(),
        body: z.string().optional(),
        kind: z.string().optional(),
        ready: z.boolean().optional(),
      },
    },
    guard(async (args) => ok(service.add(args))),
  );

  server.registerTool(
    "backlog_list",
    {
      description:
        "List this project's backlog items, newest first. Filter by status to read the queue (status:'ready') or what is parked (status:'backlog').",
      inputSchema: { status: BacklogStatus.optional() },
    },
    guard(async (args) => ok({ items: service.list(args.status) })),
  );

  server.registerTool(
    "backlog_update",
    {
      description:
        "Patch a backlog item — retitle it, rewrite its context, or move it between backlog/ready/claimed/done. Absent fields are left alone.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        kind: z.string().optional(),
        status: BacklogStatus.optional(),
      },
    },
    guard(async (args) => {
      const item = service.update(args);
      return item ? ok(item) : err(notFound("backlog item", args.id));
    }),
  );

  server.registerTool(
    "backlog_claim",
    {
      description:
        "Take a backlog item and mint its run — the intent→work transition. With no id, claims the item that has waited longest in the ready queue. This is how a conducting session picks up queued work.",
      inputSchema: { id: z.string().optional(), session_id: z.string().optional() },
    },
    guard(async (args) => {
      const outcome = service.claim(args.id, args.session_id);
      if (outcome.ok) return ok({ item: outcome.item, run: outcome.run });
      if (outcome.reason === "not_found") return err(notFound("backlog item", args.id ?? ""));
      return err(
        outcome.reason === "empty_queue"
          ? invalidState(
              "the ready queue",
              "nothing is queued",
              "Move an item to ready first — backlog_update with status:'ready'.",
            )
          : invalidState(
              "this backlog item",
              "only a ready item can be claimed",
              "Set it ready first — backlog_update with status:'ready'.",
            ),
      );
    }),
  );
}
