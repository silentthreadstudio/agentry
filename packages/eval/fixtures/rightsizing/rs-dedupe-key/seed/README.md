# users

A CommonJS module for working with user records `{ id, email, name }`. Today it exports `normalizeEmail(email)`.

Add a `dedupe(users)` helper that removes duplicate user records. Note the data: the same person can appear with a
different `id` and a differently-cased email. Keep the CommonJS export. No dependencies.
