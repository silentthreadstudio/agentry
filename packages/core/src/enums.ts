// Enums shared across the contract (doc 07 §1).
import { z } from "zod";

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
  // evolution layer (doc 01 §5) — `subject` distinguishes the harness target
  "learning",
  "gap",
  "limitation",
]);
export type MemoryType = z.infer<typeof MemoryType>;

// The routing shapes the brain chooses (doc 04). The CURRENT set is enumerated, but the stored
// value is permissive on purpose (doc 07): accept an unknown shape rather than reject it, so adding
// a shape later can't corrupt routing precedent or throw on old records.
export const KnownShape = z.enum(["one-shot", "spec-first", "decompose+verify"]);
export type KnownShape = z.infer<typeof KnownShape>;

export const Shape = z.string();
export type Shape = string;
