// Config — the config-read mechanism (doc 01 §7).
// Read from `<root>/.agentry/config.json` (project) or `~/.agentry/config.json` (global), merged
// over DEFAULT_CONFIG. The seam set is deliberately small: every toggle is a code path.
// commit-or-not is NOT here — it's the user's .gitignore.
import { z } from "zod";

export const AgentryConfig = z.object({
  workDir: z.string().default(".agentry"),
  evolution: z
    .object({
      enabled: z.boolean().default(false),
      path: z.string().optional(),
    })
    .default({ enabled: false }),
});
export type AgentryConfig = z.infer<typeof AgentryConfig>;

export const DEFAULT_CONFIG: AgentryConfig = AgentryConfig.parse({});
