# Tasks

### T1 · Add the export command
- **Owns:** `src/export.ts`, `test/export.test.ts`
- **Exposes:** `export(path)` writes the store as JSON
- **Acceptance:** `npm test` passes with a test for an empty store

### T2 · Rotate the signing key
- **Owns:** `src/keys.ts`, `test/keys.test.ts`
- **Exposes:** `rotate()` returns the new key id
- **Acceptance:** the old key still verifies until it expires
