// Config — the config-read mechanism (doc 01 §7).
// Read from `<root>/.agentry/config.json` (project) or `~/.agentry/config.json` (global), merged
// over DEFAULT_CONFIG. The seam set is deliberately small: every toggle is a code path.
// commit-or-not is NOT here — it's the user's .gitignore.
//
// THE RULE FOR ADDING A KEY: Agentry proposes, the user disposes. A repo with no `config.json` must
// behave the way the shipped defaults describe, every key must be discoverable through
// `/agentry:config`, and nothing here may silently enable a behavior the user did not ask for. Keys
// that gate a behavior-enforcing hook ship in their least surprising position.
import { z } from "zod";

export const AgentryConfig = z.object({
  workDir: z.string().default(".agentry"),
  evolution: z
    .object({
      enabled: z.boolean().default(false),
      path: z.string().optional(),
    })
    .default({ enabled: false }),

  memory: z
    .object({
      /**
       * Who gets durable memory injected into their context before they work.
       *
       *  - `off`        — nobody; recall stays something an agent must ask for.
       *  - `conductor`  — the main session only (the default). It is the one that routes, so precedent
       *                   and gotchas change the most there.
       *  - `all`        — the conductor AND every dispatched subagent.
       *
       * Why this exists: every specialist's prompt says "you are primed with recalled gotchas", and
       * nothing primed them — the SessionStart hook skips workers entirely and injected only COUNTS
       * even for the conductor. Agents were told recall had already happened, so they never called the
       * memory MCP. `all` makes the sentence true everywhere at ~200-400 tokens per worker; `conductor`
       * is the honest middle that fixes the visible gap without changing every subagent's context.
       */
      prime: z.enum(["off", "conductor", "all"]).default("conductor"),
      /** How many ranked facts a priming injection may carry. Recall is few-and-ranked, not a dump. */
      primeLimit: z.number().int().min(1).max(10).default(5),
      /**
       * Distill a `preference` fact when the user corrects, redirects, or rewrites the agent's output.
       * Off by default: it writes durable memory as a side effect of ordinary conversation, which is
       * exactly the kind of thing that should be opted into rather than discovered.
       */
      captureCorrections: z.boolean().default(false),
    })
    .default({}),
});
export type AgentryConfig = z.infer<typeof AgentryConfig>;

export const DEFAULT_CONFIG: AgentryConfig = AgentryConfig.parse({});
