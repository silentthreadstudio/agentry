// Work event log — the Workbench live feed (doc 08 §5).
import { z } from "zod";

export const WorkEvent = z.object({
  ts: z.string(),
  kind: z.string(), // "agent-started" | "agent-done" | "node" | "spend" | "done" | …
  agent: z.string().optional(),
  agentId: z.string().optional(), // correlates a subagent start with its stop
  session: z.string().optional(), // partitions lines by run/session
  detail: z.string().optional(),
});
export type WorkEvent = z.infer<typeof WorkEvent>;
