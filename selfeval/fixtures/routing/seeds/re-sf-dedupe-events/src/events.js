'use strict';

// The analytics event pipeline. The client buffers events and flushes them in
// batches. On a failed flush the client RE-ENQUEUES the same logical event and
// tries again — so a batch can legitimately contain the same user action twice.
//
// Every event carries TWO ids, and they mean different things:
//
//   - `id`        a fresh per-attempt id, stamped by stampEvent() at enqueue
//                 time. A retried event gets a NEW `id`. Two records with the
//                 same `id` never happen; two records of the SAME action have
//                 DIFFERENT `id`s.
//
//   - `eventId`   the client-supplied idempotency key for the logical action.
//                 It is STABLE across retries (see retryEvent below). This is
//                 what the ingest API already keys on server-side.
//
// `ts` is the attempt timestamp and also differs between retries.

let seq = 0;

function stampEvent(eventId, name, props) {
  seq += 1;
  return {
    id: `evt_${seq}`,        // per-attempt — changes on retry
    eventId,                 // logical action — stable across retries
    name,
    ts: Date.now(),
    props: props || {},
  };
}

// Re-enqueue a previously-stamped event for another delivery attempt.
// Note: new `id`, new `ts`, SAME `eventId`.
function retryEvent(event) {
  return stampEvent(event.eventId, event.name, event.props);
}

function sendBatch(events) {
  // Pretend network. The ingest endpoint rejects the whole batch if it sees
  // the same logical event (`eventId`) twice within one request.
  return { delivered: events.length };
}

module.exports = { stampEvent, retryEvent, sendBatch };
