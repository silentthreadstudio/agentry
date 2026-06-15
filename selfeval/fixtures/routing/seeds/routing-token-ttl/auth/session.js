// Session lifecycle: issue a token, check expiry, and renew on activity.
// Note the refresh path: `renew` extends the expiry on every active request (sliding window). Whether
// "more secure" means a shorter TTL, a HARD cap on total lifetime, or dropping the sliding renewal is
// undecided — the TTL value and the expiry MODEL are two separate calls.

import { sessionTokenTtlSeconds } from "./config.js";

export function issueToken(userId, now = Date.now()) {
  return {
    userId,
    issuedAt: now,
    expiresAt: now + sessionTokenTtlSeconds * 1000,
  };
}

export function isExpired(token, now = Date.now()) {
  return now >= token.expiresAt;
}

// Sliding expiry: each active request pushes expiry out by a fresh TTL from "now". There is no hard
// ceiling on total session lifetime — an always-active session can live indefinitely.
export function renew(token, now = Date.now()) {
  return { ...token, expiresAt: now + sessionTokenTtlSeconds * 1000 };
}
