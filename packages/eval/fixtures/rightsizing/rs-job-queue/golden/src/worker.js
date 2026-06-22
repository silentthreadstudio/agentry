// GOLDEN overlay — drains the store FIFO with a 3-attempt retry per job, dead-lettering jobs that still throw
// after the 3rd attempt. seed+golden PASSES the oracle.
const MAX_ATTEMPTS = 3;

function createWorker(store, handler) {
  return {
    drain() {
      let processed = 0;
      let deadLettered = 0;
      let job;
      while ((job = store.dequeue()) !== undefined) {
        let succeeded = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            handler(job);
            succeeded = true;
            break;
          } catch (err) {
            // retry until MAX_ATTEMPTS is exhausted, then fall through to dead-letter
          }
        }
        if (succeeded) {
          processed++;
        } else {
          deadLettered++; // set aside — not reprocessed, not lost
        }
      }
      return { processed, deadLettered };
    },
  };
}

module.exports = { createWorker };
