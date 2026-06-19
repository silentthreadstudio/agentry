// Error-envelope builders — the single home for the `code` strings and the `what`/`why`/`fix` prose
// (mirrors @agentry/memory's tools/errors.ts). No adapter constructs an error by hand; every failure
// flows through one of these so the field names, codes, and wording exist in exactly one place. Each
// constructor parses its result through the local `FlowError` schema, so a malformed envelope cannot
// escape this module.
//
// The envelope is defined HERE in FLOW (not in @agentry/core): core's `MemoryError` is the memory
// MCP's contract; FLOW is a sibling MCP with its own surface (ADR-002 keeps FLOW-internal shapes in
// FLOW's tree, graduating to core only when a second consumer needs them). Same `{code,what,why,fix}`
// shape memory proved — copied in shape, owned locally.
import { z } from "zod";

// Closed, stable machine category. A value outside the set fails to parse (the codes are closed).
export const FlowErrorCode = z.enum([
  "bad-input", // passes shape validation but is semantically invalid (blank run, out-of-range)
  "not-found", // a referenced run/task/artifact does not exist
  "invalid-state", // the target exists but the op does not apply (illegal status transition)
  "internal", // an unexpected exception inside a handler
]);
export type FlowErrorCode = z.infer<typeof FlowErrorCode>;

export const FlowError = z.object({
  code: FlowErrorCode, // stable machine category (closed set above)
  what: z.string().min(1), // what went wrong, human-readable
  why: z.string().min(1), // the cause, including the offending value where relevant
  fix: z.string().min(1), // a concrete instruction for the next call (names field + valid form)
});
export type FlowError = z.infer<typeof FlowError>;

// Input passes shape validation but is semantically invalid. `fix` names the field and states the rule.
export const badInput = (field: string, rule: string): FlowError =>
  FlowError.parse({
    code: "bad-input",
    what: "An input value is semantically invalid.",
    why: `The "${field}" value does not satisfy its constraint: ${rule}.`,
    fix: `Set "${field}" to a value that satisfies: ${rule}, then retry.`,
  });

// A referenced run/task/artifact does not exist. `why` surfaces the offending id; `fix` points at how
// to get a real one (run_start mints the run; task_list/run_get list what exists).
export const notFound = (what: string, id: string): FlowError =>
  FlowError.parse({
    code: "not-found",
    what: `The requested ${what} does not exist.`,
    why: `No ${what} was found for "${id}".`,
    fix: `Pass an existing ${what} — call run_start to mint a run, or list/get first to obtain a valid id, then retry.`,
  });

// The target exists but the operation does not apply to its current state. The caller supplies the
// state-specific prose (e.g. an illegal status transition), since only it knows actual vs required.
export const invalidState = (what: string, why: string, fix: string): FlowError =>
  FlowError.parse({ code: "invalid-state", what, why, fix });

// An unexpected exception inside a handler. Generic, fixed prose — embeds no exception, stack, or path,
// so nothing about the host filesystem or internals leaks to the caller.
export const internal = (): FlowError =>
  FlowError.parse({
    code: "internal",
    what: "An unexpected internal error occurred.",
    why: "The handler failed for an internal reason, not because of the caller's input.",
    fix: "Retry the request; if it persists, the issue is server-side and not fixable by changing the call.",
  });
