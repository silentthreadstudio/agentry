# Spec: add a per-key rate limiter to the API gateway

## Job-to-be-done
Protect upstream services from a single client's bursts: allow each key up to `limit` requests per `windowMs`,
deny the rest. Today there is no limiter; abusive keys saturate the backend.

## Decisions surfaced (the load-bearing forks)
1. **Window semantics — FIXED vs SLIDING (the load-bearing fork).** "N per window" is ambiguous. A FIXED window
   resets the counter every interval, which lets a burst of up to `2 × limit` slip across a boundary (limit at the
   end of one bucket, limit at the start of the next). We choose a **SLIDING window** over the trailing `windowMs`:
   it admits a request only while fewer than `limit` hits fall in `(now − windowMs, now]`, so the boundary burst is
   denied. This matches the JTBD ("protect the backend") — the fixed window's burst is exactly the failure mode.
   *Override:* if memory pressure from per-key timestamp lists matters more than burst-tightness, switch to a fixed
   or token-bucket window — change `allow` and document the looser boundary guarantee.
2. **Clock injection.** `now()` is injected (not `Date.now()`) so the limiter is deterministically testable and the
   window math has a single source of time.
3. **Deny does not record.** A denied request consumes no budget — only admitted hits count toward `limit`.

## Scope
In: `createLimiter({ limit, windowMs, now })` → `{ allow(key) }`, sliding-window admission, per-key isolation.
Out (non-goals): distributed/shared state across processes, persistence, dynamic per-key limits, response headers —
none are needed for the single-process gateway this serves.

## Acceptance
- `limit` hits in a window are admitted, the next denied; a hit aging past `windowMs` frees a slot; a 2×limit
  boundary burst is DENIED (the sliding-window guarantee); limits are per-key.
