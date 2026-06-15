// A background worker: a sibling to whatever delivers notifications. It drains a queue and "sends"
// each item out-of-band. A notification-delivery worker would mirror this loop.

const queue = [];

export function enqueueEmail(job) {
  queue.push(job);
}

export function startEmailWorker({ intervalMs = 1000 } = {}) {
  return setInterval(() => {
    while (queue.length > 0) {
      const job = queue.shift();
      deliver(job);
    }
  }, intervalMs);
}

function deliver(job) {
  // Pretend to send the email.
  process.stdout.write(`[email] sent ${job.template} to ${job.to}\n`);
}
