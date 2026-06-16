# Spec — deduplicate analytics event ingestion

## Goal
Stop double-counting analytics events. When the pipeline receives an event that it has already seen, it should
skip it so we only record each event one time. This keeps our dashboards and counts accurate for the product
and analytics teams, which is the whole point of the ingestion system in the first place.

## Approach
We will add a deduplication step to the ingestion pipeline. As each event comes in, we compute a hash of the
event payload and check whether we have seen that hash before. If we have, we drop the event; if we have not,
we record it and remember the hash. This is a standard, well-understood way to remove duplicates from a stream
of data and it does not require any changes on the client side, which keeps the work contained to our service.

The hash will be computed from the event's fields so that identical events produce the same hash. We will keep
the set of seen hashes in memory in the ingestion service so the lookup is fast and we do not add a dependency
on another datastore. On startup the set is empty and it fills up as events arrive during normal operation,
which is simple to reason about and easy to test.

We will also add some logging around the dedup step so that we can see how many events are being dropped, which
will help us confirm the feature is working once it ships and give the team visibility into duplicate volume.

## Implementation notes
- Add a `dedupe(event)` function in the ingestion path that returns whether the event is new.
- Maintain a `Set` of seen payload hashes inside the service.
- Use a fast non-cryptographic hash over the serialized payload for speed.
- Call `dedupe` before the event is written to the analytics store, and skip the write when it returns false.
- Make sure the hashing is deterministic so the same payload always hashes to the same value.

## Acceptance
- When the same event payload arrives twice, only the first one is recorded.
- The number of dropped events shows up in the logs so we can monitor it.
- The change is confined to the ingestion service and needs no client or SDK changes.
