---
name: integrating
description: This skill should be used when assembling completed work and verifying the whole product against the Spec's acceptance criteria as observed end-to-end behavior — catching the "every task passed individually but the product is broken" integration gap. Loaded for the final whole-product check across the seams where independently-built tasks meet, not for verifying a single task or unit.
version: 0.1.0
---

# Integrating

Run the **whole product** against the **Spec's acceptance criteria** as observed behavior. Per-task green does not mean the product works — the failure mode this skill exists to catch is *every task passed alone, the assembled thing is broken*. Check the seams, not the diffs.

## The one rule that makes assemble worth running

**Observe end-to-end behavior, not per-task results.** The Spec ACs describe the *product* doing something; prove each by exercising the assembled system, not by re-reading the task verdicts. Independently-built tasks can each be locally correct and still fail where they meet — and only running across the seam reveals it. If all you do is confirm the task checkmarks, you have added nothing.

**The scope floor — and its symmetric ceiling.** Assemble checks the **seams** and the **Spec ACs**, *not* each task's own unit ACs over again. Those were already gated at verify; re-verifying behavior at the unit level here is over-checking — the symmetric failure to skimming the seams. Stay at the whole-product altitude: what the seams do when wired, and what the Spec promises end-to-end.

## Why per-task green is not enough

Each task verified against its own `## Acceptance` in isolation, often with mocks at its boundaries. The gaps live *between* tasks:

- **Contract mismatch** — task A returns what task B didn't expect (shape, null, units, encoding).
- **Ordering / lifecycle** — A must run/initialize before B; alone both pass, wired up they deadlock or race.
- **Shared state** — two tasks touch the same store/config/global and clobber each other.
- **Mocked-away seam** — a boundary stubbed in unit tests is wrong against the real dependency.
- **Missing wiring** — a task built a capability nobody actually calls; coverage looked complete, behavior isn't.
- **Cross-cutting AC** — a Spec AC ("the flow completes in under 2s", "an unauthenticated user is rejected at every step") that no single task owns.

## Method

1. **Pull the Spec ACs** (`AC1..n`) — these, not the task acceptances, are the bar. The task `satisfies` links show which tasks *claim* to cover each; trust the claim only after you observe it.
2. **Stand up the whole product** — run the real assembled system (real wiring, real dependencies where feasible), not the unit harnesses.
3. **For each Spec AC, exercise the end-to-end path** that proves it, and record the **method**: the command, the request/response, the driven UI interaction + screenshot, the measured number. **Any Spec AC whose end-to-end path can't be observed with the tools available is UNVERIFIED + a named blocker** — for *any* AC type, not just UI. Never infer an AC from per-task green: a green unit is not an observed product behavior.
4. **Probe the seams deliberately** — the handoffs between tasks listed above. Feed the boundary the inputs the unit tests mocked.
5. **Write the assemble verdict**: per-Spec-AC PASS/FAIL with cited evidence + any integration gotcha discovered.

## The Workbench steering signal (forced status change)

A `<channel source="agentry-flow">` event with `kind=status` (attributes `run_id` / `task` / `status`) is a human forcing a task's lifecycle status from the Workbench — e.g. marking it `done` to accept it as-is, or back to `todo` to redo it. Treat it as **steering, not noise**: re-read that task's status from the files (the files are the truth, not your in-memory plan) and adjust what you assemble next accordingly — a task forced `done` is now in scope for the seam check; one forced back to `todo` is not yet ready and its seams stay unverified.

## Tools (capability-first)

- Run the product → prefer the repo's own run/serve/e2e command if present → fallback: invoke the entry point directly.
- Verify UI flows → a browser MCP (chrome-devtools / claude-in-chrome) to drive and observe the real screens → else mark the AC **UNVERIFIED**.
- Run the full suite → the repo's test runner; an integration/e2e target if one exists.

## Anti-patterns (refuse these)

- **Checking diffs instead of behavior** — assemble is *only* meaningful as observed end-to-end behavior.
- **Re-summarizing task verdicts** — confirming the checkmarks adds nothing; the gaps are between them.
- **Re-verifying unit ACs** — re-checking each task's own acceptance at assemble; it was already gated. Stay at the seam/Spec-AC altitude.
- **Inferring an unobservable AC from per-task green** — if the e2e path can't be observed, the AC is UNVERIFIED with a named blocker, never assumed-passed.
- **Bare PASS** — every Spec AC cites the end-to-end method that proved it.
- **Mock-deep assemble** — if the real seams are still mocked, you haven't assembled.
- **Skipping cross-cutting ACs** because no single task owns them — those are the ones assemble exists for.

## Output

A per-Spec-AC verdict: each AC → `PASS` / `FAIL` / `UNVERIFIED` with its **end-to-end method/evidence**, the integration gotchas found (named for the moat), and the overall ship / don't-ship call grounded in the results. Report any memory that shaped the check in `used_memories`.

## Additional resources

### Reference files
- **`references/assemble-checklist.md`** — the seam-failure catalog with how to provoke each, the cross-cutting-AC patterns, and how to trace coverage from Spec AC → tasks → observed behavior.
