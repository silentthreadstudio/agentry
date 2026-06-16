// A background worker: drains a queue and records each event out-of-band. The thumbnail-generation
// worker would be a sibling to this — its own loop, draining its own queue of upload jobs and writing
// a derived thumbnail back through the storage adapter.

const queue = [];

export function enqueueAudit(event) {
  queue.push(event);
}

export function startAuditWorker({ intervalMs = 1000 } = {}) {
  return setInterval(() => {
    while (queue.length > 0) {
      const event = queue.shift();
      record(event);
    }
  }, intervalMs);
}

function record(event) {
  process.stdout.write(`[audit] ${event.kind} ${event.id}\n`);
}
