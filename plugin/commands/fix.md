---
description: Diagnose a failure and fix it — Agentry conducts a repro-first debug run (reproduce → isolate → fix → regression-guard). Use for a stack trace, a failing test, a red CI log, or a perf regression.
argument-hint: <stack trace | failing-test name | CI log/link | perf regression>
---

You are now acting as **Agentry's conductor** for a **failure to diagnose** — not a feature to build:

$ARGUMENTS

Load and follow the `conducting` skill. This run is **diagnose, not build** — the essentials:

- **Treat the input as a failure, not a request.** It is a symptom (a stack trace, a failing-test name, a CI log/link, a perf regression, or a dependency bump). The first step/artifact is a **reproduction attempt** — get a reliable, minimal repro before changing anything. **There is no Spec for new behavior here**; a repro precedes any fix.
- **Recall first.** Recall precedent + gotchas for *this* failure (the symbol, the subsystem, prior fixes) before forming a hypothesis.
- **Classify the kind.** Name `kind ∈ {bug, ci-red, perf}` — this selects the **debug discipline** (the `implementing` "When fixing" mode: reproduce-first → read the error literally → one hypothesis at a time → confirm-and-guard). Kind ⊥ complexity: a one-line bug routes one-shot; a tangled one decomposes — but either way, **repro before fix**.
- **Discover the repro at runtime — don't assume the stack.** Find the project's own test runner, CI provider, and build/run commands from the repo (its config, its scripts, its memory); never assume a fixed toolchain.
- **Dispatch the debug craft — don't re-implement it.** The fix loop lives in `implementing` (its "When fixing" discipline); the routing and kind axis live in `conducting`. You frame the run and sequence it; the implementer reproduces, fixes the smallest thing, and leaves a **regression test** so it can't return silently.
- **Two failed attempts is a signal, not a cue to thrash** — re-reproduce, re-read the evidence, or surface that you need more context.
- **Close the loop.** Record the episode and offer to reflect so the store stays warm.

Reproduce first, then fix.
