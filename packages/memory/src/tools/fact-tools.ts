// Fact tools — thin MCP adapters over MemoryService. Input is validated by the SDK against the zod
// raw shape, then handed to the service (cast at this boundary to the service's exact-optional types).
// Each adapter switches the service's typed outcome → ok(payload) on success or err(builder(...)) on
// failure (ADR-001 §B); envelope prose lives in tools/errors.ts, never built here (AC8).
import { MemoryType, Scope } from "@agentry/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  FeedbackInput,
  MemoryService,
  RecallInput,
  UpdatePatch,
  WriteInput,
} from "../application/memory-service.js";
import { guard, partial } from "./adapter.js";
import { badInput, invalidState, notFound } from "./errors.js";
import { err, ok } from "./result.js";

export function registerFactTools(server: McpServer, service: MemoryService): void {
  server.registerTool(
    "memory_write",
    {
      description:
        "Capture a durable semantic memory (gotcha/decision/preference/repo-fact/learning/gap/limitation). Apply the write-bar first (will it change a future decision?). Dedup-reinforces a near-duplicate instead of creating a copy.",
      inputSchema: {
        type: MemoryType,
        scope: Scope,
        text: z.string(),
        why: z.string().optional(),
        tags: z.array(z.string()).optional(),
        subject: z.string().optional(),
        repoId: z.string().optional(),
        supersedes: z.string().optional(),
        provenance: z.array(z.string()).optional(),
      },
    },
    guard(async (args) => ok(service.write(args as WriteInput))),
  );

  server.registerTool(
    "memory_recall",
    {
      description:
        "Few, ranked, scope-aware memories for the task — never superseded, safe to inject. mode:'prime' (no query) returns the session warm set: top facts + recent episodes.",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().positive().optional(),
        mode: z.enum(["task", "prime"]).optional(),
      },
    },
    guard(async (args) => ok(service.recall(args as RecallInput))),
  );

  server.registerTool(
    "memory_search",
    {
      description: "Broader full-text search with snippets — for exploration when recall's few aren't enough.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
    },
    guard(async (args) => ok({ results: service.search(args.query, args.limit) })),
  );

  server.registerTool(
    "memory_update",
    {
      description: "Patch a fact in place (text/tags/type/scope/confidence/status/supersedes) — for reflect/curation.",
      inputSchema: {
        id: z.string(),
        text: z.string().optional(),
        tags: z.array(z.string()).optional(),
        type: MemoryType.optional(),
        scope: Scope.optional(),
        confidence: z.number().min(0).max(1).optional(),
        status: z.enum(["active", "superseded"]).optional(),
        supersedes: z.string().optional(),
      },
    },
    guard(async (args) => {
      const { id, ...patch } = args;
      const outcome = service.update(id, patch as UpdatePatch);
      if (outcome.ok) return ok({ id: outcome.id, updated: true });
      if (outcome.reason === "bad-input") return err(badInput(outcome.field, outcome.rule));
      return err(notFound(outcome.id));
    }),
  );

  server.registerTool(
    "memory_feedback",
    {
      description:
        "Record the usefulness signal after a run: used+pass boosts; recalled-but-unused decays; used+fail-in-domain is suspect (lowers confidence); recall-misses nudge.",
      inputSchema: {
        recalled: z.array(z.string()),
        used: z.array(z.string()),
        outcome: z.enum(["pass", "fail"]),
        recallMisses: z.array(z.string()).optional(),
      },
    },
    guard(async (args) => partial(service.feedback(args as FeedbackInput))),
  );

  server.registerTool(
    "memory_forget",
    {
      description:
        "Remove a memory by id — from the live store and disk. The manual-removal override (doc 02 §3); use sparingly — decay handles routine cleanup.",
      inputSchema: { id: z.string() },
    },
    guard(async (args) => {
      const outcome = service.forget(args.id);
      if (outcome.ok) return ok({ forgotten: true, kind: outcome.kind });
      if (outcome.reason === "bad-input") return err(badInput(outcome.field, outcome.rule));
      return err(notFound(outcome.id));
    }),
  );

  server.registerTool(
    "memory_recover",
    {
      description:
        "Restore a tombstoned (archived) memory back to active — the recover side of auto-decay; decay handles archiving, this undoes a false-archive.",
      inputSchema: { id: z.string() },
    },
    guard(async (args) => {
      const outcome = service.recover(args.id);
      if (outcome.ok) return ok({ recovered: true });
      if (outcome.reason === "bad-input") return err(badInput(outcome.field, outcome.rule));
      if (outcome.reason === "not-found") return err(notFound(outcome.id));
      return err(
        invalidState(
          "cannot recover this memory",
          `it is '${outcome.status}', not archived`,
          "recover only applies to archived facts",
        ),
      );
    }),
  );
}
