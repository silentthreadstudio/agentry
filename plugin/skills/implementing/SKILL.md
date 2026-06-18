---
name: implementing
description: This skill should be used when writing or changing code to satisfy a defined boundary — building a feature slice inside a Task contract, fixing a bug, wiring logic into files a task owns, or making a clean bounded edit. Covers both building new code and debugging existing code (the fixing mode). Loaded for code-writing work, not for design, decomposition, or review.
version: 0.1.0
---

# Implementing

Write the **least code that satisfies the contract, reads clearly, and matches the repo** — then prove it works. The boundary is already drawn (by the Task's `contract`, or by the obvious scope of a one-shot); the craft here is building *well inside it*, not redrawing it. Clean and bounded beats clever and sprawling.

## The three rules that govern every change

1. **Stay inside the boundary.** Touch only the files the contract owns (`contract.owns`). The boundary is what makes parallel work safe and stops the god-file. If the change truly needs a file outside it, **stop and surface that** — do not reach across.
2. **Match the repo.** Read the surrounding code before writing. Use its naming, error handling, layering, libraries, and test layout. A plain solution consistent with the codebase beats a clever foreign one. Never add a dependency or pattern the repo doesn't already use without a decision behind it.
3. **Right-sized.** Write only what the acceptance needs. No speculative abstraction, no unused config, no handling of cases the contract excludes. Gold-plating is a failure mode, not thoroughness.

## Method (building)

1. **Restate "done."** From the Task acceptance (or the request), state in one line what observably-working looks like. If it can't be restated crisply, **or it leaves a decision the implementation must make**, the work is blocked — surface it (`NEEDS_CONTEXT` / `NEEDS_DECISION`), don't guess.
2. **Read before writing.** Open the owned files and their immediate neighbors. Note the conventions in force and any recalled gotchas for these files. Prefer a semantic code-intel tool (Serena / LSP) to read structure fast; fall back to grep / glob / read.
3. **Write the smallest correct change.** Implement the exposed behavior directly. Keep functions cohesive (one job each); keep the public surface small; keep the diff focused on the contract. **Small footprint ≠ small decision:** if an undecided design choice surfaces *inside* an owned file — an identity / routing / ordering / naming question the contract never resolved — STOP and surface it (`NEEDS_CONTEXT` / `NEEDS_DECISION`). Do **not** resolve that fork silently inside the edit; a one-line change can still hide a decision that should have gone to a gate.
4. **Run the checks the repo provides.** Tests, linter, typechecker — via the repo's own scripts/runner. Green before you call it done.
5. **Self-check against acceptance and boundary.** Every acceptance item observably met; nothing edited outside `contract.owns`.

## When fixing (vs building)

Fixing is a different discipline from building — most failed fixes come from skipping it and guessing. When the input is a *failure to diagnose* (a `bug` / `ci-red` / `perf` task), follow this loop, not intuition. Three of its steps are **guarantees, not suggestions** — the gate, the regression artifact, and the gotcha close are what make a fix trustworthy:

1. **Reproduce-first GATE — the failing repro precedes any fix.** Before changing one line, capture the failure as a **failing test, observed RED** — the *first* artifact of the run. (Where a test is genuinely impossible, a documented **deterministic repro** — exact steps + observed wrong output — stands in.) **No fix may precede a repro.** A fix you can't reproduce-then-watch-pass is a guess, and an unreproduced fix fails this gate. For a `perf` failure the repro is a measurement against a **stated baseline** (e.g. "operation X takes <observed> vs. the <baseline> target"), reproduced before the change — *reproduce-and-improve*, not a profiling harness.
2. **Read the error literally.** The stack trace, the assertion, the actual-vs-expected — take them at face value before theorizing. The bug is usually where the evidence points, not where you assume.
3. **Hypothesis, then test.** Form *one* explicit hypothesis ("the timezone is dropped because X parses before Y"), then make the smallest change that would confirm or kill it. Don't change five things hoping one works.
4. **Change one variable at a time.** If a change doesn't move the needle, revert it before trying the next. Stacked speculative edits hide which one mattered and create new bugs.
5. **Bisect when lost.** If the cause is unclear, narrow it: comment out / binary-search the input, or use the repo's history-bisect tool, until the failing region is small. Localize before fixing.
6. **Regression guarantee — confirm the fix and LEAVE the guard.** Watch the repro flip RED → green, then run the surrounding suite and confirm it stays green. The repro test is a **required left-green artifact: it stays in the suite** as a regression guard (never deleted after the fix, never left as a throwaway). A fix without a committed, passing regression test is not done. (For `perf`, the guard asserts the improved measurement holds against the stated baseline.)
7. **Remember-the-gotcha close — surface the root cause for harvest.** On a *successful* debug run, surface the bug's **root cause** (not the symptom) as a gotcha with provenance — what was actually wrong, the subsystem it lives in, and the run/episode it came from — so the conductor can harvest it via the **existing `memory_write`** tool (the conductor writes; you surface). This closes the loop: the same failure becomes recallable for the touched subsystem next time. Do not write memory yourself or invent a new memory tool — the seam is *implementer surfaces, conductor harvests*.

> **Two failed attempts is a signal, not a cue to thrash.** Stop re-rolling guesses; re-reproduce, re-read the evidence, or surface that you need more context. Undisciplined retries burn the budget and add noise.

## Anti-patterns (refuse these)

- **Editing outside the contract** — surface the need (`NEEDS_CONTEXT`) instead of reaching across.
- **God-file** — piling unrelated logic into one file for convenience; keep cohesion, respect the seam.
- **Gold-plating** — abstractions / options / coverage the contract never asked for.
- **Convention drift** — a new lib/pattern/style the repo doesn't use, with no decision behind it.
- **Guess-driven debugging** — changing code without a repro and a hypothesis; stacking speculative edits.
- **Silently deciding an undecided fork** — resolving an identity/routing/ordering/naming choice the contract never made, inside the edit, instead of surfacing it. Small footprint ≠ small decision.
- **Silent acceptance-miss** — calling it done when an acceptance item isn't actually met.

## Output

A focused diff inside the owned files, with the repo's checks green, plus tests for the behavior (see the `testing` skill). Report which acceptance items are met, anything left as a concern, and any memory that changed the code in `used_memories`.

## Additional resources

### Reference files
- **`references/clean-code-and-debugging.md`** — what "clean" means concretely (naming, function size, comments-as-why, error handling, small public surfaces), the right-sizing rubric, and the full systematic-debugging playbook (repro → isolate → bisect → fix → regression-test).
