# event-log

An account ledger across three files with clean seams:
- `src/ledger.js` — `createLedger()` → `{ post(entry), entries() }`, append-only `{ account, amount }` list.
- `src/reducer.js` — PURE `applyEntry(balances, entry)` → a NEW balances object (missing account = 0; no mutation).
- `src/index.js` — `balances(ledger)` folds every entry via `applyEntry` over `{}`.

The seed ships stub signatures; fill them in. Keep CommonJS exports. No dependencies.
