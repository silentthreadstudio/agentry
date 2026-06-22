# event-replay

Build an event-sourced counter across three files with clean seams:
- `src/log.js` — `createLog()` → `{ append(event), all() }`, an in-memory append-only event list.
- `src/reducer.js` — `apply(state, event)`, a PURE reducer (`inc`/`dec` by `event.by`, default 1; unknown types
  leave state unchanged).
- `src/index.js` — `replay(log)` folds every event over initial state `0` using `apply`.

The seed ships the stub signatures; fill them in. Keep CommonJS exports. No dependencies.
