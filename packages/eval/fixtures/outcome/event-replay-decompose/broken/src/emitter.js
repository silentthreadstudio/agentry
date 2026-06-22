// BROKEN overlay — the PLAUSIBLE-NAIVE solution: a plain live pub/sub. emit() fans out to current subscribers;
// subscribe() just registers a handler. The live happy path works, but there is NO replay buffer (a late
// subscriber silently misses every event emitted before it joined) and NO de-dup (a repeated id is delivered
// again). seed+broken FAILS the oracle on the late-join replay and de-dup TRAP cases. The bug is the missing
// buffer + de-dup coordination, not an obvious stub.
function createEmitter() {
  const subscribers = new Set();

  function emit(event) {
    for (const handler of subscribers) {
      handler(event);
    }
  }

  function subscribe(handler) {
    subscribers.add(handler);
    return function unsubscribe() {
      subscribers.delete(handler);
    };
  }

  return { emit, subscribe };
}

module.exports = { createEmitter };
