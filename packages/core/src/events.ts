// Work event log — the Workbench live feed (doc 08 §5).
import { z } from "zod";

export const WorkEvent = z.object({
  ts: z.string(),
  kind: z.string(), // "agent-started" | "node" | "spend" | "done" | …
  agent: z.string().optional(),
  detail: z.string().optional(),
});
export type WorkEvent = z.infer<typeof WorkEvent>;
