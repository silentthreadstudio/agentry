# event-ledger

An event-sourced account ledger across five files with clean seams:
- `src/events.js` — `deposit(account, amount)`, `withdraw(account, amount)`, `transfer(from, to, amount)` →
  validated event objects (amount = positive integer cents; transfer's `from` and `to` must differ).
- `src/reducer.js` — PURE `apply(state, event)` → a NEW state with balances updated (missing account = 0; no mutation).
- `src/projection.js` — `replay(initialState, events)` folds `apply` over `events` from `initialState` (nullish = empty).
- `src/snapshot.js` — `snapshot(state)` + `restore(snap)`; a round-trip deep-equals the state and shares no references.
- `src/index.js` — `createLedger()` → `{ append, balanceOf, snapshotNow, eventCount }`. After a snapshot, reads
  replay only the events appended strictly AFTER it on top of the snapshot state (each exactly once).

The seed ships stub signatures; fill them in. Keep CommonJS exports. No dependencies.
