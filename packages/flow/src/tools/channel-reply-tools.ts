// Channel-reply tool — the agent→human reply lane (ADR-002, Phase 2a). A thin MCP adapter over
// ReviewService.reply: it appends an agent-origin entry to the gate's `.review/` sidecar (the SAME bus
// the human's comments ride) so the agent can send a short ack/status back to the Workbench rail in
// answer to a `<channel>` review comment — WITHOUT writing a document. The reply is marked
// `origin:"agent"`, so the channel bridge never re-pushes it (no echo loop) and `review_list` / the
// open-gate inbox stay human-only. Mirrors review-tools.ts: SDK validates the zod input shape, the
// service owns id-minting + the agent-origin marking, `guard` maps an unexpected throw (e.g. a poisoned
// run/doc rejected by the store's segment guard) to the `internal` envelope.
//
// `doc` is the gate key (== docId): the SAME key the human's `<channel>` meta carries and the same key
// review_comment writes under, so a reply lands on the artifact the human commented on.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ReviewService } from "../application/review-service.js";
import type { ReviewStore } from "../domain/ports.js";
import { guard } from "./adapter.js";
import { ok } from "./result.js";

// The slice of the shared service context this family needs — the run-keyed review sidecar store (the
// reply rides the same store as the human comments). Typed structurally, decoupled from index.ts.
interface ChannelReplyCtx {
  reviews: ReviewStore;
}

export function registerChannelReplyTools(server: McpServer, ctx: ChannelReplyCtx): void {
  const service = new ReviewService(ctx.reviews);

  server.registerTool(
    "channel_reply",
    {
      description:
        "Send a short reply/status back to the human in the Agentry Workbench conversation rail, in answer to a review comment. Use after addressing or acknowledging a <channel> review comment.",
      inputSchema: {
        run: z.string(),
        doc: z.string(), // the gate key (== docId) — the artifact the human commented on
        body: z.string(),
        replyTo: z.string().optional(), // the human comment id this answers (threading)
      },
    },
    guard(async (args) =>
      ok(service.reply({ run: args.run, gate: args.doc, body: args.body, replyTo: args.replyTo })),
    ),
  );
}
