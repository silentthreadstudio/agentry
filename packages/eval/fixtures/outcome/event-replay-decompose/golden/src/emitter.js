// GOLDEN overlay — coordinates the three concerns: a replay buffer (de-duped by id), replay to each new
// subscriber in emission order, then live delivery. seed+golden PASSES the held-out oracle.
function createEmitter() {
  const buffer = []; // every de-duped event, in emission order
  const seen = new Set(); // ids already emitted (de-dup)
  const subscribers = new Set(); // live handlers

  function emit(event) {
    if (seen.has(event.id)) return; // de-dup by id: never buffer or deliver twice
    seen.add(event.id);
    buffer.push(event);
    for (const handler of subscribers) {
      handler(event);
    }
  }

  function subscribe(handler) {
    for (const event of buffer) {
      handler(event); // replay the buffer to the late subscriber, in order, BEFORE live delivery
    }
    subscribers.add(handler);
    return function unsubscribe() {
      subscribers.delete(handler);
    };
  }

  return { emit, subscribe };
}

module.exports = { createEmitter };
