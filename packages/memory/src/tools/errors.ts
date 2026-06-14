// Error-envelope builders — the single home for the `code` strings and the `what`/`why`/`fix` prose
// (ADR-001 §A, AC8). No adapter constructs a `MemoryError` by hand; every failure flows through one of
// these so the field names, codes, and wording exist in exactly one place. Each constructor parses its
// result through the core schema, so a malformed envelope cannot escape this module.
import { type MemoryError, MemoryError as MemoryErrorSchema } from "@agentry/core";

// A referenced id does not exist. `why` surfaces the offending id; `fix` points at how to get a real one.
export const notFound = (id: string): MemoryError =>
  MemoryErrorSchema.parse({
    code: "not-found",
    what: "The requested record does not exist.",
    why: `No record was found for id "${id}".`,
    fix: "Pass the id of an existing record — list or search first to obtain a valid id, then retry.",
  });

// Input passes shape validation but is semantically invalid. `fix` names the field and states the rule.
export const badInput = (field: string, rule: string): MemoryError =>
  MemoryErrorSchema.parse({
    code: "bad-input",
    what: "An input value is semantically invalid.",
    why: `The "${field}" value does not satisfy its constraint: ${rule}.`,
    fix: `Set "${field}" to a value that satisfies: ${rule}, then retry.`,
  });

// The target exists but the operation does not apply to its current state. The caller supplies the
// state-specific prose (e.g. recover-on-non-archived), since only it knows the actual vs required state.
export const invalidState = (what: string, why: string, fix: string): MemoryError =>
  MemoryErrorSchema.parse({ code: "invalid-state", what, why, fix });

// A store record on disk was corrupt or unreadable. Names the offending file; not retryable by changing
// the call — the fix is to repair the file, not to re-issue the request.
export const storageRead = (file: string): MemoryError =>
  MemoryErrorSchema.parse({
    code: "storage-read",
    what: "A stored record could not be read.",
    why: `The file "${file}" is corrupt or unreadable.`,
    fix: `Repair or restore "${file}" on disk; retrying this call unchanged will not help.`,
  });

// An unexpected exception inside a handler. Generic, fixed prose — embeds no exception, stack, or path,
// so nothing about the host filesystem or internals leaks to the caller (AC7).
export const internal = (): MemoryError =>
  MemoryErrorSchema.parse({
    code: "internal",
    what: "An unexpected internal error occurred.",
    why: "The handler failed for an internal reason, not because of the caller's input.",
    fix: "Retry the request; if it persists, the issue is server-side and not fixable by changing the call.",
  });
