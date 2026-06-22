# rates

A CommonJS module exposing `getRate(code, opts)`. Today it calls `opts.fetch(code)` on every call — expensive.

Make it faster by caching, but a cached rate must not be served forever: `opts` provides `ttlMs` and `now()` —
serve from cache while younger than `ttlMs`, recompute once older. Cache per `code`. Keep the CommonJS export.
No dependencies.
