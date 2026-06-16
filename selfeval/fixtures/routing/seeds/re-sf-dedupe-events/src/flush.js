'use strict';

const { stampEvent, retryEvent, sendBatch } = require('./events');

// The flush loop. Pulls buffered events, stamps a fresh attempt id on each,
// and ships them. On failure the events are re-stamped via retryEvent and put
// back on the buffer — which is how the same logical action ends up in a batch
// more than once.
function flush(buffer) {
  const batch = buffer.map((e) => stampEvent(e.eventId, e.name, e.props));
  const res = sendBatch(batch);
  if (res.delivered < batch.length) {
    return batch.map(retryEvent); // requeue the attempts that didn't land
  }
  return [];
}

module.exports = { flush };
