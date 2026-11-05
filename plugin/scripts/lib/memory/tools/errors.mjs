// Error envelopes — the single home for the `code` strings and the `what`/`why`/`fix` prose a refused call
// carries. No verb builds one by hand; every failure flows through one of these, so the field names, codes
// and wording exist in exactly one place. An envelope is { code, what, why, fix }: `code` is a stable
// machine category (bad-input, not-found, invalid-state, storage-read, internal), the rest is prose that is
// complete without the code.

// A referenced id does not exist. `why` surfaces the offending id; `fix` points at how to get a real one.
export const notFound = (id) => ({
  code: "not-found",
  what: "The requested record does not exist.",
  why: `No record was found for id "${id}".`,
  fix: "Pass the id of an existing record — search first to obtain a valid id, then retry.",
});

// None of several referenced ids could be applied (all missing/ineligible — the all-invalid partial case).
// Same `code` and field set as notFound; `why` lists each id distinctly so the caller can see which.
export const notFoundMany = (ids) => ({
  code: "not-found",
  what: "None of the requested records could be applied.",
  why: `No record was found for any of these ids: ${ids.map((id) => `"${id}"`).join(", ")}.`,
  fix: "Pass ids of existing records — search first to obtain valid ids, then retry.",
});

// Input passes shape validation but is semantically invalid. `fix` names the field and states the rule.
export const badInput = (field, rule) => ({
  code: "bad-input",
  what: "An input value is semantically invalid.",
  why: `The "${field}" value does not satisfy its constraint: ${rule}.`,
  fix: `Set "${field}" to a value that satisfies: ${rule}, then retry.`,
});

// The target exists but the operation does not apply to its current state. The caller supplies the
// state-specific prose (e.g. recover-on-non-archived), since only it knows the actual vs required state.
export const invalidState = (what, why, fix) => ({ code: "invalid-state", what, why, fix });

// A store record on disk was corrupt or unreadable. Names the offending file; not retryable by changing
// the call — the fix is to repair the file, not to re-issue the request.
export const storageRead = (file) => ({
  code: "storage-read",
  what: "A stored record could not be read.",
  why: `The file "${file}" is corrupt or unreadable.`,
  fix: `Repair or restore "${file}" on disk; retrying this call unchanged will not help.`,
});

// An unexpected exception inside a verb. Generic, fixed prose — embeds no exception, stack, or path, so
// nothing about the host filesystem or internals leaks to the caller.
export const internal = () => ({
  code: "internal",
  what: "An unexpected internal error occurred.",
  why: "The command failed for an internal reason, not because of the caller's input.",
  fix: "Retry the command; if it persists, the issue is in the memory store and not fixable by changing the call.",
});
