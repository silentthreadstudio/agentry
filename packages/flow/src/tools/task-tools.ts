// Task tools — thin MCP adapters over TaskService (the highest-leverage FLOW family). Each adapter
// validates input via the SDK against its zod raw shape, hands plain values to the service, then
// switches the service's typed outcome → ok(payload) | err(builder(...)). Envelope prose lives in
// tools/errors.ts, never built here. Mirrors @agentry/memory's tools/*-tools.ts style exactly.
//
// ADR-005 NO branch: every tool takes `run` as a REQUIRED arg — there is no ambient current run. The
// store resolves the run dir via T01's `runDir(ctx.cwd, run)` (a poisoned id is rejected by
// `assertSafeSegment` inside the store) — no folder scan, no ambient run.
//
// The three v1 failures, closed here by construction:
//  - AC2 (status drift): `task_status`'s `status` field IS the closed `FlowTaskStatus` zod enum, so an
//    out-of-enum value fails SDK validation BEFORE the handler runs — no file is written.
//  - AC3 (lockedBy): `task_assign` requires `agent`; the service always stamps it into `lockedBy`.
//  - AC4/AC5 (version): every write routes through the store, which stamps a tool-computed `version`.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FlowTaskStatus } from "../domain/status.js";
import { TaskService } from "../application/task-service.js";
import type { FlowServices } from "../index.js";
import { guard } from "./adapter.js";
import { notFound } from "./errors.js";
import { err, ok } from "./result.js";

export function registerTaskTools(server: McpServer, ctx: FlowServices): void {
  const service = new TaskService(ctx.tasks);

  server.registerTool(
    "task_create",
    {
      description:
        "Create the next task file (tasks/NNN-*.md) in a run. The tool numbers it and stamps a content-hash version (AC5). Requires `run` (call run_start first to mint one — ADR-005, no ambient run).",
      inputSchema: {
        run: z.string(),
        title: z.string(),
        body: z.string().optional(),
      },
    },
    guard(async (args) => ok(service.create(args.run, args.title, args.body ?? ""))),
  );

  server.registerTool(
    "task_assign",
    {
      description:
        "Assign an agent to a task — sets `lockedBy` on the task frontmatter (never empty for an assigned task, AC3) and re-stamps the version. Requires `run`.",
      inputSchema: {
        run: z.string(),
        taskNo: z.string(),
        agent: z.string(),
      },
    },
    guard(async (args) => {
      const outcome = service.assign(args.run, args.taskNo, args.agent);
      if (outcome.ok) return ok(outcome.value);
      return err(notFound("task", outcome.id));
    }),
  );

  server.registerTool(
    "task_status",
    {
      description:
        "Move a task to a new lifecycle status. `status` is the CLOSED enum {todo,in-progress,in-review,done} — any other value is rejected at the schema and no file is written (AC2). Re-stamps the version (AC5). Requires `run`.",
      inputSchema: {
        run: z.string(),
        taskNo: z.string(),
        // The closed FlowTaskStatus enum IS the validation boundary (AC2): an out-of-enum value fails
        // here, before the handler — so an invalid status can never reach a file.
        status: FlowTaskStatus,
      },
    },
    guard(async (args) => {
      const outcome = service.status(args.run, args.taskNo, args.status);
      if (outcome.ok) return ok(outcome.value);
      return err(notFound("task", outcome.id));
    }),
  );

  server.registerTool(
    "task_get",
    {
      description: "Read one task (frontmatter + body) by its number. Requires `run`.",
      inputSchema: {
        run: z.string(),
        taskNo: z.string(),
      },
    },
    guard(async (args) => {
      const outcome = service.get(args.run, args.taskNo);
      if (outcome.ok) return ok(outcome.value);
      return err(notFound("task", outcome.id));
    }),
  );

  server.registerTool(
    "task_list",
    {
      description: "List all tasks in a run (a fresh directory scan over tasks/*.md — ADR-001 pure-file). Requires `run`.",
      inputSchema: {
        run: z.string(),
      },
    },
    guard(async (args) => ok(service.list(args.run))),
  );

  server.registerTool(
    "artifact_write",
    {
      description:
        "Write a run-root artifact (spec.md or plan.md) and stamp a tool-computed content-hash version (AC4). Editing the body and rewriting yields a different version. Requires `run`.",
      inputSchema: {
        run: z.string(),
        kind: z.enum(["spec", "plan"]),
        body: z.string(),
      },
    },
    guard(async (args) => ok(service.artifact(args.run, args.kind, args.body))),
  );
}
