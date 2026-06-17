// Auth configuration.

// How long a session token stays valid, in seconds. Currently 1 hour.
// Trade-off lives here: shorter forces re-auth more often (safer, worse UX); longer is the reverse.
export const sessionTokenTtlSeconds = 3600;
