// Background worker: wakes on an interval and processes work out-of-band. This existing digest loop
// is the sibling pattern. The new scheduler worker for campaigns lives alongside it — each tick it
// finds campaigns whose scheduledAt has passed and that are still pending, and triggers their send.

const jobs = [];

export function enqueueDigest(job) {
  jobs.push(job);
}

export function startWorker({ intervalMs = 1000 } = {}) {
  return setInterval(() => {
    const now = Date.now();
    while (jobs.length > 0 && jobs[0].runAt <= now) {
      run(jobs.shift());
    }
  }, intervalMs);
}

function run(job) {
  process.stdout.write(`[worker] ran ${job.kind} ${job.id}\n`);
}
