# job-queue

An in-memory job queue across five files with clean seams:
- `src/store.js` — `createStore()` → `{ enqueue, dequeue, peek, size }`, FIFO order.
- `src/backoff.js` — PURE `delayFor(attempt)` → a capped exponential retry delay (100, 200, 400, … capped at 5000 ms).
- `src/deadletter.js` — `createDeadLetter()` → `{ add, list, size }`, holds permanently failed jobs.
- `src/worker.js` — `runOnce(store, deadLetter, handler, maxAttempts)` → pulls one job, runs its handler, on failure
  schedules a retry (preserving fairness so others run first) or dead-letters after `maxAttempts`. Returns whether a
  job was processed.
- `src/index.js` — `createQueue({ maxAttempts })` → `{ add, process, stats }`. `add` enqueues a job, `process(handler)`
  drains the queue, `stats()` → `{ pending, deadLettered, processed }`.

The seed ships stub signatures; fill them in. Keep CommonJS exports. No dependencies.
