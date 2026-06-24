# limiter

A per-key rate limiter. Add `createLimiter({ limit, windowMs, now })` → `{ allow(key) }`.

`allow(key)` is `true` while the key has fewer than `limit` allowed hits in the trailing `windowMs` ending at
`now()`, and records the hit; otherwise `false` (and records nothing). `now()` is the injected ms clock. Keep the
CommonJS export. No dependencies.
