// A background worker: it drains a queue and processes each job out-of-band. A moderation worker that
// flags banned words in comments would be a sibling to this — same enqueue/drain loop, different job.

const queue = [];

export function enqueueIndexJob(job) {
  queue.push(job);
}

export function startIndexWorker({ intervalMs = 1000 } = {}) {
  return setInterval(() => {
    while (queue.length > 0) {
      const job = queue.shift();
      reindex(job);
    }
  }, intervalMs);
}

function reindex(job) {
  // Pretend to rebuild a search index entry.
  process.stdout.write(`[index] reindexed ${job.kind} ${job.id}\n`);
}
