# Spec — deduplicate analytics event ingestion

## Goal
Record each real analytics event exactly once, even when client SDKs deliver it multiple times (retries,
at-least-once queues), without collapsing genuinely distinct events that merely look alike.

## The load-bearing decisions (auto-decided — each reversible)

### 1. What identifies "the same event" (the dedup key)
This is the decision the whole feature rests on. Two candidates:
- a **client-supplied idempotency key** (the SDK stamps each logical event with a UUID and resends the *same*
  id on retry), or
- a **server-computed content hash** (hash of payload fields).

**Decision: use the client-supplied idempotency key as the dedup key; fall back to a content hash only when the
key is absent.** Rationale: a content hash alone is wrong here — two distinct events with identical fields
(e.g. the same user clicking the same button twice, legitimately) hash equal and one would be silently dropped.
The idempotency key is the only signal that distinguishes "a retry of one event" from "two real events."
*Assumption:* the current SDKs send (or can be made to send) a stable per-event id on retry.
*Override:* if a meaningful share of traffic has no client id, flip the default to content-hash + a short time
bucket and accept the small false-merge rate — change `DEDUP_KEY_SOURCE` in the ingestion config.

### 2. How long a key is remembered (the dedup window)
Deduping forever needs unbounded storage; deduping too briefly lets a late retry through.
**Decision: a 24h sliding window keyed in Redis with TTL.** Rationale: covers realistic client retry/backoff
horizons while bounding storage.
*Assumption:* retries beyond 24h are rare enough to tolerate.
*Override:* raise/lower via `DEDUP_WINDOW_HOURS`; a stricter exactly-once need would move this to a durable
store with no expiry (a larger change, flagged as out of scope below).

### 3. What wins on a key hit
**Decision: first-write-wins — the first event for a key is recorded, later duplicates are dropped and counted
as `deduped`.** Rationale: the first arrival is the canonical one; later copies carry no new information.
*Override:* switch to last-write-wins via `DEDUP_RESOLUTION` if payload enrichment on retry must be preserved.

## Scope
- In: dedup at the ingestion boundary, the Redis-backed key store, a `deduped` counter for observability.
- Non-goals: backfilling/deduping already-recorded historical events; cross-region dedup (single-region only);
  changing the SDKs' retry behavior; a durable exactly-once guarantee beyond the 24h window.

## Acceptance
- A replayed event (same idempotency key) within the window is recorded once; the duplicate increments `deduped`.
- Two distinct events with identical payloads but different keys are BOTH recorded.
- A key first seen after the window expires is treated as new.
