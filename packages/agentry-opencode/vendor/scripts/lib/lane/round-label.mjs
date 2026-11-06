// round-label — how a round is named for the owner. A round the lane held before its report was read
// (the builder stopped for a restart, the owner parked it) did no build or verify work: it is `r3
// (restart)`, so the owner's count of build and verify rounds matches. The number is the ledger's, unchanged.
// A guard hold keeps its guards, so it is a round that did work and is not labelled. Pure.

/** Is round `r` one that only stopped: held, with no report status, no verdict and no guard trip. */
export const stoppedOnly = (r) => r.held === true && !r.status && !r.verdict && !r.guards;

/** `r<n>`, with ` (restart)` after it for a round that only stopped. */
export const roundLabel = (r) => `r${r.n}${stoppedOnly(r) ? " (restart)" : ""}`;
