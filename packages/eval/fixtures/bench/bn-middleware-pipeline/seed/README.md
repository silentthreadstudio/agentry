# middleware-pipeline

A synchronous request/response middleware pipeline across five files with clean seams:
- `src/context.js` — `createContext(request)` → mutable `ctx { request, response, state }`; `send(ctx, status, body)` helper.
- `src/compose.js` — PURE `compose(middlewares)` → `run(ctx)`. Each middleware is `(ctx, next) => void`; a middleware that
  does NOT call `next()` short-circuits (the rest of the chain MUST NOT run); `next()` may be called at most once.
- `src/middlewares.js` — `auth()`, `validate()`, `rateLimit(limit)`, `responder()`. `auth` short-circuits with 401 when
  the `authorization` header is missing; `validate` 400 on a missing body; `rateLimit` 429 over the limit; `responder` is
  the terminal 200 handler.
- `src/errors.js` — `errorResponse(err)` maps a thrown error (honoring `.status`) to `{ status, body }`, default 500.
- `src/index.js` — `createApp(middlewareOrder)` → `{ handle(request) }`. Composes the middlewares in the GIVEN order, runs
  them, maps any thrown error, returns `ctx.response`. The required full-app order is
  `[auth(), rateLimit(limit), validate(), responder()]` and a short-circuit at any stage stops every later stage.

The seed ships stub signatures; fill them in. Keep CommonJS exports. No dependencies.
