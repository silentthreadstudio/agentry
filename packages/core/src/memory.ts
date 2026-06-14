// Memory records — the moat's data shapes (doc 07 §1).
import { z } from "zod";
import { MemoryType, Scope, Shape, Status } from "./enums.js";

export const Fact = z.object({
  id: z.string(), // origin-qualified ULID — "g:01J…" (global) | "p:01J…" (project)
  type: MemoryType,
  scope: Scope,
  text: z.string(),
  why: z.string().optional(),
  tags: z.array(z.string()).optional(),
  subject: z.string().optional(), // evolution only
  confidence: z.number().min(0).max(1),
  usefulness: z.number().min(0),
  status: Status,
  supersedes: z.string().optional(),
  provenance: z.array(z.string()).optional(), // source episode/fact ids — the interlink graph
  repoId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Fact = z.infer<typeof Fact>;

export const Episode = z.object({
  id: z.string(),
  task: z.string(),
  shape: Shape,
  outcome: z.string(),
  retries: z.number().optional(),
  lesson: z.string().optional(),
  usedMemories: z.array(z.string()).optional(), // citation signal (doc 02 §4)
  recallMisses: z.array(z.string()).optional(),
  distilled: z.boolean(), // idempotent file field (doc 03)
  repoId: z.string().optional(),
  createdAt: z.string(),
});
export type Episode = z.infer<typeof Episode>;
