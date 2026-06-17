// A background worker: it drains a queue and processes each job out-of-band. The inventory-reservation
// worker would be a sibling to this — same enqueue/drain loop, but each job decrements catalog stock
// for a checked-out cart and marks the reservation done (or releases it if stock ran out).

const queue = [];

export function enqueueFulfillmentJob(job) {
  queue.push(job);
}

export function startFulfillmentWorker({ intervalMs = 1000 } = {}) {
  return setInterval(() => {
    while (queue.length > 0) {
      const job = queue.shift();
      fulfill(job);
    }
  }, intervalMs);
}

function fulfill(job) {
  // Pretend to hand the order to a downstream fulfillment system.
  process.stdout.write(`[fulfillment] dispatched order ${job.orderId}\n`);
}
