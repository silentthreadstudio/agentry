// phases — the one list of which phases count as started and which as closed. A work item's phase is
// derived by `read.mjs`; the rules and the capability check (`can a kind ever be started?`) read the
// same two sets, so they cannot disagree about it. PURE.

/** The phases of work that has begun. */
export const STARTED = new Set(["active", "done"]);
/** The phases of work that is over, finished or set aside. */
export const CLOSED = new Set(["done", "dropped", "parked"]);
