// Job model: an in-memory store with the shape the rest of the app builds on. Today it only holds
// generic records (a queued payload, no lifecycle yet) — there is no status, attempt count, or
// failure tracking. The job-queue feature would extend this to carry the fields the worker and the
// dead-letter handler need (status, attempts, lastError).

const records = new Map();
let nextId = 1;

export function insert(payload) {
  const id = String(nextId++);
  const record = { id, payload, createdAt: Date.now() };
  records.set(id, record);
  return record;
}

export function get(id) {
  return records.get(id);
}

export function all() {
  return [...records.values()];
}
