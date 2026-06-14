// Structured error envelope — the one shape every memory MCP tool returns on failure (ADR-001 §A).
// A calling model sees only the response, so the envelope must be machine-routable (`code`) AND
// self-explanatory (`what`/`why`/`fix`). Pure data shape: no logic, no imports beyond zod.
import { z } from "zod";

// Closed, stable machine category. A sixth value fails to parse (AC8 — the set is closed in core).
export const MemoryErrorCode = z.enum([
  "bad-input", // passes shape validation but is semantically invalid (blank id, limit ≤ 0)
  "not-found", // a referenced id does not exist
  "invalid-state", // the target exists but the op does not apply (recover on a non-archived id)
  "internal", // an unexpected exception inside a handler
  "storage-read", // a store record was corrupt/unreadable (not retryable by changing the call)
]);
export type MemoryErrorCode = z.infer<typeof MemoryErrorCode>;

export const MemoryError = z.object({
  code: MemoryErrorCode, // stable machine category (closed set above)
  what: z.string().min(1), // what went wrong, human-readable
  why: z.string().min(1), // the cause, including the offending value where relevant
  fix: z.string().min(1), // a concrete instruction for the next call (names field + valid form)
});
export type MemoryError = z.infer<typeof MemoryError>;
