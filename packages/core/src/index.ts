// @agentry/core — the typed contract. Single source of truth for every structured shape
// Agentry reads or writes. Imported by @agentry/memory, the benchmark, the check-plugin gate,
// and (later) the workbench. Mirrors the design docs; keep them in lockstep.

import { z } from "zod";

/* ───────────────────────── Enums (doc 07 §1) ───────────────────────── */

export const Scope = z.enum(["user", "global", "repo"]);
export type Scope = z.infer<typeof Scope>;

export const Status = z.enum(["active", "superseded"]);
export type Status = z.infer<typeof Status>;

export const MemoryType = z.enum([
  // semantic core
  "gotcha",
  "decision",
  "preference",
  "repo-fact",
  // evolution layer (doc 01 §5) — subject distinguishes the harness target
  "learning",
  "gap",
  "limitation",
]);
export type MemoryType = z.infer<typeof MemoryType>;

// The routing shapes the brain chooses (doc 04). The CURRENT set is enumerated, but the stored
// value is permissive on purpose (doc 07): accept an unknown shape rather than reject it, so
// adding a shape later can't corrupt routing precedent or throw on old records.
export const KnownShape = z.enum(["one-shot", "spec-first", "decompose+verify"]);
export type KnownShape = z.infer<typeof KnownShape>;
export const Shape = z.string();
export type Shape = string;

/* ─────────────────────── Memory records (doc 07 §1) ─────────────────── */

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

/* ──────────────── Artifact frontmatter (doc 01) — structured parts ──── */

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

/* ─────────────────────── Event log (doc 08 §5) ─────────────────────── */

export const WorkEvent = z.object({
  ts: z.string(),
  kind: z.string(), // "agent-started" | "node" | "spend" | "done" | …
  agent: z.string().optional(),
  detail: z.string().optional(),
});
export type WorkEvent = z.infer<typeof WorkEvent>;

/* ─────────────── Config — the config-read mechanism (doc 01 §7) ─────── */
// Read from `<root>/.agentry/config.json` (project) or `~/.agentry/config.json` (global),
// merged over DEFAULT_CONFIG. The seam set is deliberately small (doc 01 §7): every toggle is a
// code path. commit-or-not is NOT here — it's the user's .gitignore.

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
