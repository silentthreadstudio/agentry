// Enums shared across the contract.
import { z } from "zod";

export const Scope = z.enum(["user", "global", "repo"]);
export type Scope = z.infer<typeof Scope>;

export const Status = z.enum(["active", "superseded", "archived"]);
export type Status = z.infer<typeof Status>;

export const MemoryType = z.enum([
  // semantic core
  "gotcha",
  "decision",
  "preference",
  "repo-fact",
  // evolution layer — `subject` distinguishes the harness target
  "learning",
  "gap",
  "limitation",
]);
export type MemoryType = z.infer<typeof MemoryType>;

// The routing shapes the brain chooses. The CURRENT set is enumerated, but the stored
// value is permissive on purpose: accept an unknown shape rather than reject it, so adding
// a shape later can't corrupt routing precedent or throw on old records.
export const KnownShape = z.enum(["one-shot", "spec-first", "decompose+verify"]);
export type KnownShape = z.infer<typeof KnownShape>;

// The shape a run's work-folder artifacts EVIDENCE (what the self-eval reads back from `.agentry/work/`), in
// ascending process weight: `one-shot` writes nothing, `spec-first` leaves a `spec.md`, `decompose` leaves a
// `plan.md` and/or `tasks/`. It is `KnownShape`'s `decompose+verify` seen from the artifacts: the verify step
// leaves no artifact of its own, so the artifact name is the shorter one.
export const RoutedShape = z.enum(["one-shot", "spec-first", "decompose"]);
export type RoutedShape = z.infer<typeof RoutedShape>;

export const Shape = z.string();
export type Shape = string;

// The routing kind axis — orthogonal to Shape. The CURRENT set is enumerated, but the
// stored value is permissive on purpose (same rationale as Shape): accept an unknown kind rather
// than reject it, so adding a kind later can't corrupt routing precedent or throw on old records.
export const KnownKind = z.enum(["feature", "bug", "refactor", "perf", "dep-upgrade", "ci-red"]);
export type KnownKind = z.infer<typeof KnownKind>;

export const Kind = z.string();
export type Kind = string;
