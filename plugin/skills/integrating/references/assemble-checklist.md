# Assemble Checklist — depth

Reference for the `integrating` skill. The assemble pass exists to catch what unit verification structurally cannot: failures *between* independently-built tasks. This file is the catalog of those failures, how to provoke each, and how to trace coverage so nothing is silently dropped.

## The coverage trace (do this first)

Before exercising anything, build the map: **Spec AC → tasks that `satisfies` it → the observable behavior that proves it.**

- Every Spec AC must trace to ≥1 task. An AC with no task behind it is a **dropped criterion** (the v1 failure) — FAIL it back to the conductor; it was never built.
- An AC whose tasks all passed in isolation is still **unproven** at the product level until you observe the end-to-end behavior. The trace tells you *where* to look; it does not substitute for looking.
- A cross-cutting AC ("rejected at every step", "completes under budget") often traces to *no* single task. Those are the highest-value assemble checks — nobody owned them, so nobody verified them.

## Seam-failure catalog — and how to provoke each

The unit pass mocks the boundary; assemble feeds the boundary the real thing.

| Failure | What it looks like | How to provoke it |
| :--- | :--- | :--- |
| **Contract mismatch** | A returns a shape/type/null/unit B didn't expect | call the real A → feed its real output to the real B; don't stub A |
| **Ordering / lifecycle** | B depends on A being initialized first | run the real startup sequence; restart and re-run; check init order |
| **Shared state** | two tasks write the same store/config/global | run both paths against the *same* live store and check for clobber |
| **Mocked-away seam** | a stub in unit tests is wrong vs the real dependency | replace the mock with the real dependency and re-exercise |
| **Missing wiring** | a built capability nothing actually invokes | trace the call graph from a real entry point; is it reached? |
| **Error-path divergence** | A's error shape isn't what B's handler catches | force A to fail; observe B's behavior, not B's unit test |
| **Auth/state across steps** | session/permission held by step 1, lost by step 3 | drive the full multi-step flow as one real session |

## Cross-cutting AC patterns

These rarely map to one task and are the assemble pass's reason to exist:

- **End-to-end correctness** — "a user can complete <flow>" — drive the entire flow on the real system; screenshot/observe each step's result.
- **Security-across-steps** — "an unauthenticated request is rejected at every endpoint" — hit each step unauthenticated; one open step is a FAIL.
- **Performance budget** — "the page/response is within N" — measure on the assembled system, not a component in isolation.
- **Consistency** — "the same data shows the same way everywhere" — exercise two surfaces that read the same source; compare.
- **Idempotency / retry** — "running it twice is safe" — actually run it twice against live state.

## Standing up the whole product

Assemble is only valid against real wiring:

- Prefer the repo's own run/serve/e2e command — it encodes the real composition.
- Use real dependencies where feasible (real DB, real adjacent service). Every mock left in place is a seam you did *not* test — note it as a coverage limit in the verdict.
- For UI ACs, drive the real screens with a browser MCP and capture screenshots; if none is available, the AC is **UNVERIFIED** with the blocker named — never inferred.

## Writing the assemble verdict

Same citable-line discipline as `reviewing`, scoped to Spec ACs and end-to-end method:

```
AC1  PASS    drove signup→verify→login via chrome-devtools; screenshots reviews/assemble/ac1-*.png; flow completed, dashboard rendered
AC4  FAIL    multi-step flow: step 3 (checkout) 500s because cart service returns cents, payment task expects dollars — contract mismatch at the cart↔payment seam (real call, not mocked)
AC6  UNVERIFIED  no load tool available to measure the <2s budget on the assembled stack; needs a timing/trace capability
```

Name every integration gotcha discovered (e.g. "cart↔payment seam: units mismatch, cents vs dollars") so the conductor harvests it into memory and the next change at that seam is born warned.
