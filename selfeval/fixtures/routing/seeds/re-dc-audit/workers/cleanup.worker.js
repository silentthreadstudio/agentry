// A background worker: a sibling to whatever prunes old audit entries. It wakes on an interval and
// drops stale items by age. A retention worker for the audit log would mirror this loop and threshold.

const items = [];

export function trackItem(item) {
  items.push({ ...item, createdAt: Date.now() });
}

export function startCleanupWorker({ intervalMs = 60000, maxAgeMs = 86400000 } = {}) {
  return setInterval(() => {
    const cutoff = Date.now() - maxAgeMs;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].createdAt < cutoff) items.splice(i, 1);
    }
  }, intervalMs);
}
