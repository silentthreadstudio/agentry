// Review tools — thin MCP adapters over ReviewService (spec AC10). The review sidecar: per-gate
// annotation files beside the run, not inline in the reviewed artifact. Input is validated by the SDK
// against the zod raw shape (the 3-way anchor from domain/review.ts), then handed to the service;
// each adapter maps the service's typed outcome → ok(payload) / err(builder(...)). Envelope prose
// lives in tools/errors.ts, never built here. `guard` wraps every handler so an unexpected throw
// (e.g. a poisoned `run`/`gate` rejected by the store's segment guard) becomes the `internal`
// envelope. Mirrors @agentry/memory's fact-tools.ts adapter shape.
//
// ADR-005 NO branch: every tool takes `run` as a REQUIRED arg — there is no ambient run; the
// conductor threads the handle. The ReviewStore resolves `run`→`runDir(cwd, run)` internally and
// asserts it is a safe single path segment, so a traversal id can never escape `.review/`.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ReviewService } from "../application/review-service.js";
import type { ReviewStore } from "../domain/ports.js";
import { ReviewAnchor, ReviewDecision } from "../domain/review.js";
import { guard } from "./adapter.js";
import { notFound } from "./errors.js";
import { err, ok } from "./result.js";

// The slice of the shared service context this family needs — the run-keyed review sidecar store.
// Typed structurally (not against the whole FlowServices) so this file stays decoupled from index.ts.
interface ReviewCtx {
  reviews: ReviewStore;
}

export function registerReviewTools(server: McpServer, ctx: ReviewCtx): void {
  const service = new ReviewService(ctx.reviews);

  server.registerTool(
    "review_comment",
    {
      description:
        "Append a review comment with the 3-way anchor (originalText + headingAnchor + startLine) to a gate's annotation sidecar (.review/<gate>.annotations.json). The anchor re-locates the comment after the reviewed document changes. Returns the new comment's id.",
      inputSchema: {
        run: z.string(),
        gate: z.string(),
        anchor: ReviewAnchor,
        decision: ReviewDecision,
        body: z.string(),
      },
    },
    guard(async (args) =>
      ok(service.comment({ run: args.run, gate: args.gate, anchor: args.anchor, decision: args.decision, body: args.body })),
    ),
  );

  server.registerTool(
    "review_resolve",
    {
      description:
        "Mark one review comment resolved (by id) so resolved comments are distinguishable from open ones. Idempotent; an unknown id is not-found.",
      inputSchema: { run: z.string(), gate: z.string(), id: z.string() },
    },
    guard(async (args) => {
      const outcome = service.resolve(args.run, args.gate, args.id);
      if (outcome.ok) return ok({ id: outcome.id, resolved: true });
      return err(notFound("comment", outcome.id));
    }),
  );

  server.registerTool(
    "review_list",
    {
      description:
        "List a gate's review comments — what the conductor reads AT the gate to see open vs. resolved annotations.",
      inputSchema: { run: z.string(), gate: z.string() },
    },
    guard(async (args) => ok(service.list(args.run, args.gate))),
  );
}
