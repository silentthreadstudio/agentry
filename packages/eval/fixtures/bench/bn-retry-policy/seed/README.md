# retry

A small retry wrapper. Add `withRetry(fn, { retries })`.

Call `fn()`; on a thrown error retry up to `retries` more times, then return or throw the last error. An error
carries a `retriable` boolean — only retriable errors retry; a non-retriable error rethrows immediately. `fn` is
synchronous. Keep the CommonJS export. No dependencies.
