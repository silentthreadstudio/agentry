// The two record shapes the store holds — a Fact and an Episode — as `domain/check.mjs` validators, and the
// closed sets they name. The same fields and rules as `@agentry/core`'s memory schemas (the typed contract
// of the MCP server this replaces); `parse` is zod's `safeParse` in the shape `check.mjs` gives it. Pure.
//
// Fact.parse(data) / Episode.parse(data) -> { ok: true, value } | { ok: false, message }
import {
  arrayOf,
  boolean,
  number,
  object,
  oneOf,
  optional,
  string,
  withDefault,
} from "./check.mjs";

export const SCOPES = ["user", "global", "repo"];
export const STATUSES = ["active", "superseded", "archived"];
export const MEMORY_TYPES = [
  // semantic core
  "gotcha",
  "decision",
  "preference",
  "repo-fact",
  // evolution layer: `subject` names the harness target
  "learning",
  "gap",
  "limitation",
];

export const Fact = object({
  id: string, // origin-qualified ULID: "g:01J…" (global) | "p:01J…" (project)
  type: oneOf(MEMORY_TYPES),
  scope: oneOf(SCOPES),
  text: string,
  why: optional(string),
  tags: optional(arrayOf(string)),
  subject: optional(string), // evolution only
  confidence: number({ min: 0, max: 1 }),
  usefulness: number({ min: 0 }),
  decay: withDefault(number({ min: 0 }), 0), // recalled-but-unused strike counter
  status: oneOf(STATUSES),
  archivedAt: optional(string), // tombstone timestamp
  supersedes: optional(string),
  provenance: optional(arrayOf(string)), // source episode/fact ids
  repoId: optional(string),
  createdAt: string,
  updatedAt: string,
});

// `shape` is permissive on purpose: an unknown shape is accepted rather than rejected, so adding a
// routing shape later can't throw on old records.
export const Episode = object({
  id: string,
  task: string,
  shape: string,
  outcome: string,
  retries: optional(number()),
  lesson: optional(string),
  usedMemories: optional(arrayOf(string)),
  recallMisses: optional(arrayOf(string)),
  distilled: boolean, // idempotent file field
  repoId: optional(string),
  createdAt: string,
});
