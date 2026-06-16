// Background worker: drains a queue and processes each job out-of-band. The new retry worker for
// failed deliveries is a sibling to this loop — it picks up deliveries that errored or timed out and
// re-attempts them with backoff, giving up after a max-attempts ceiling.

const queue = [];

export function enqueueJob(job) {
  queue.push(job);
}

export function startWorker({ intervalMs = 1000 } = {}) {
  return setInterval(() => {
    while (queue.length > 0) {
      const job = queue.shift();
      process(job);
    }
  }, intervalMs);
}

function process(job) {
  process.stdout.write(`[worker] handled ${job.kind} ${job.id}\n`);
}
