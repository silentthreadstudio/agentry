# validation-pipeline

A tiny CommonJS validation pipeline split across THREE coordinating modules. Each file in `src/` ships a stub that
throws; implement them so rules run IN ORDER and STOP at the first failure.

## The three modules

- `src/rules.js` — rule FACTORIES. Each returns a rule function `(input) -> null | string`: `null` on pass, an
  error MESSAGE on failure. Provide at least:
  - `required(field)` — fails with `` `${field} is required` `` when `input[field]` is missing / empty string.
  - `minLength(field, n)` — fails with `` `${field} must be at least ${n} characters` `` when shorter than `n`.
  - `isEmail(field)` — fails with `` `${field} must be a valid email` `` when it lacks a single `@` with text
    on both sides.
- `src/runner.js` — `runRules(input, rules)`: run the rules IN ORDER; return the FIRST non-null message, or `null`
  if all pass. It must SHORT-CIRCUIT — once a rule fails, later rules are NOT called.
- `src/index.js` — the barrel: `validate(input, rules)` wraps the runner and returns
  `{ ok: true, errors: [] }` when all pass, or `{ ok: false, errors: [message] }` with ONLY the first failing
  rule's message. Re-export the rule factories from here too.

No dependencies; keep the CommonJS exports.
