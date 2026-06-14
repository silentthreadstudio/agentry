// Artifact frontmatter — the structured parts agents write (doc 01).
import { z } from "zod";

export const TaskStatus = z.enum(["todo", "in-progress", "blocked", "in-review", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Contract = z.object({
  owns: z.array(z.string()), // files/modules this task owns
  exposes: z.string(), // the public interface it exposes
});
export type Contract = z.infer<typeof Contract>;

export const TaskFrontmatter = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskStatus,
  owner: z.string().optional(),
  lockedBy: z.string().optional(), // Workbench lock while in-progress (doc 08 §3)
  version: z.string().optional(), // content-hash for optimistic concurrency (doc 08 §2)
  satisfies: z.array(z.string()).default([]), // → Spec AC ids (coverage)
  deps: z.array(z.string()).default([]), // serialize only where contracts overlap
  contract: Contract,
});
export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>;

export const SpecFrontmatter = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["draft", "approved", "superseded"]),
  version: z.string().optional(),
});
export type SpecFrontmatter = z.infer<typeof SpecFrontmatter>;
