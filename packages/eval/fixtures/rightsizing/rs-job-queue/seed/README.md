# job-queue

Build a small in-memory job queue across three files with clean seams:
- `src/store.js` — `createStore()` → `{ enqueue(job), dequeue(), size() }`, a FIFO (`dequeue()` returns
  `undefined` when empty).
- `src/worker.js` — `createWorker(store, handler)` → `{ drain() }`. `drain()` synchronously processes every
  queued job in FIFO order via `handler(job)`; if `handler` throws, retry the same job up to 3 ATTEMPTS total,
  and if it still throws after the 3rd attempt set it aside as a DEAD LETTER (don't lose it, don't reprocess it).
  `drain()` returns `{ processed, deadLettered }`.
- `src/index.js` — `createQueue(handler)` → `{ submit(job), drain(), stats() }` wiring a store + worker;
  `stats()` → `{ processed, deadLettered, pending }` (pending = jobs still in the store).

The seed ships the stub signatures; fill them in. Keep CommonJS exports. No dependencies.
