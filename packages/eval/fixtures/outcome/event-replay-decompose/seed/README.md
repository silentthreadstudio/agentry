# emitter

A tiny CommonJS module exposing `createEmitter()` — an event emitter with a replay buffer.

`src/emitter.js` ships a stub that throws; implement it so a late subscriber is not left behind:

- a handler that subscribes LATE receives every buffered event in emission order, then live events after
- an event whose `id` was already emitted is ignored (no duplicate delivery)
- `unsubscribe()` (the return of `subscribe`) stops all further delivery to that handler

`emit(event)` takes an event with a unique `id`; `subscribe(handler)` returns an `unsubscribe` function. No
dependencies; keep the CommonJS export (`module.exports = { createEmitter }`).
