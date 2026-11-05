# Tasks

### T1 · Sign-up form
- **Owns:** `src/ui/signup.tsx`, `src/ui/signup.test.tsx`
- **Exposes:** the `/signup` screen
- **Acceptance:** a new account can sign up; a taken email shows an error

### T2 · Password reset
- **Owns:** `src/auth/reset.ts`, `src/auth/reset.test.ts`
- **Exposes:** `requestReset(email)` and `reset(token, password)`
- **Acceptance:** a token works once and expires after an hour

### T3 · Invoice export
- **Owns:** `src/billing/export.ts`, `src/billing/export.test.ts`
- **Exposes:** `exportInvoices(month)` returns CSV
- **Acceptance:** totals match the ledger for a sample month
