# Clean Code & Debugging — depth

Reference for the `implementing` skill. Two parts: what "clean, bounded code" means concretely, and the systematic playbook for fixing bugs. Both serve one end — **code that does exactly what the contract says and can be changed safely later.**

## What "clean" means concretely

Clean is not ornament; it's the properties that make code readable and changeable. Apply with judgment, scaled to the work.

- **Names carry intent.** A name should say what a thing *is* or *does*, not how it's built or what type it is. If a reader needs the implementation to understand the name, rename it. Match the codebase's existing vocabulary.
- **Functions do one thing.** A function you can't describe without "and" is probably two functions. Keep them small enough to hold in your head; extract a cohesive sub-step when it earns a name. Don't extract a one-line helper used once — that's ceremony.
- **Small public surface.** Expose the minimum the contract promises. Everything else stays private. A narrow surface is what lets the inside change without breaking callers.
- **Comments explain *why*, not *what*.** The code says what it does; a comment earns its place only when intent, a non-obvious constraint, or a gotcha isn't visible from the code. Delete comments that restate the line.
- **Errors handled at the right layer.** Fail fast on programmer errors; handle expected failures where there's enough context to decide. Match the repo's error convention (exceptions vs. result types vs. error returns) — don't introduce a new one.
- **No dead weight.** No unused params, no commented-out code left behind, no "just in case" branches. If it isn't reached, it isn't needed.

## Right-sizing the implementation

Every abstraction costs indirection and concepts. Pay only when the work returns it:

| Work | What clean looks like |
| :--- | :--- |
| One-liner / throwaway fix | direct code, no new structure, just match the local style |
| Small feature in an existing module | follow local conventions; minimal new functions; no new layers |
| A real slice with edges and volatility | cohesive functions, a small interface at the genuine seam, tests on behavior |

Over-applying structure to small work is itself an anti-pattern — it produces the ceremony Agentry exists to avoid. Under-structuring a real feature produces the god-file. Aim for the floor and escalate only on evidence.

## The systematic debugging playbook

Most failed fixes are guesses dressed as fixes. The discipline that beats guessing. Three steps are **guarantees, not preferences** — the reproduce-first gate (step 1), the regression artifact (step 5), and the gotcha close (step 6); the loop's craft is the same it has always been, but those three are now load-bearing and verifiable.

### 1. Reproduce — the GATE, before touching anything
- This is a **gate, not a warm-up**: the run's **first** artifact is a **failing test observed RED** that captures the failure. **No fix may precede the repro.** Strip the scenario to the smallest thing that still fails.
- Express the repro as a failing test — it is also the regression guard you leave behind (step 5). Only where a test is genuinely impossible does a **documented deterministic repro** (exact steps + observed wrong output) stand in for it.
- A bug you can't reproduce, you can't confirm you fixed. If it's intermittent, find the nondeterminism (time, order, concurrency, uninitialized state) first.
- **Perf is a *reported* failure with a repro**, not a profiling exercise: reproduce the regression as a measurement against a **stated baseline** ("X took `<observed>` vs. the `<baseline>` target") before the change, then *reproduce-and-improve*. Building a profiling/benchmark harness is out of scope.

### 2. Read the evidence literally
- Take the stack trace, assertion, and actual-vs-expected at face value before theorizing. The first real frame in *your* code is usually the place to look.
- Distinguish the **symptom** (where it blew up) from the **cause** (why). Trace back from the symptom along the evidence, not along your assumptions.

### 3. Hypothesis, then test — one at a time
- Write down a single falsifiable hypothesis: "the value is wrong because X happens before Y."
- Make the smallest change or probe (a log line, a breakpoint, a unit test) that confirms or kills it.
- **Change one variable at a time.** If a change doesn't help, revert it before the next. Stacked speculative edits hide which one mattered and breed new bugs.

### 4. Bisect when the cause is unclear
- **In the input:** binary-search the data — halve it until the failing region is small.
- **In the code:** disable / stub halves of the path until the failing half is isolated.
- **In history:** the repo's history-bisect tool to find the commit that introduced it. A known-good→bad boundary localizes the cause fast.

### 5. Fix at the cause, then guard it — the regression artifact stays
- Fix the root cause, not the symptom — patching the symptom leaves the bug alive elsewhere.
- Keep the fix inside the contract. If the true cause is outside the owned files, surface that (`NEEDS_CONTEXT`); don't widen scope silently.
- Watch the repro flip RED → green, then run the surrounding suite and confirm it stays green.
- **The regression test is a required left-green artifact: leave it in the suite.** The failing test from step 1, now passing, stays committed as the guard — it is not deleted after the fix and not a throwaway. A fix without a committed, passing regression test is not done. (For perf, the guard asserts the improved measurement holds against the stated baseline.)

### 6. Close the loop — remember the gotcha
On a *successful* debug run, surface the bug's **root cause** as a gotcha for the conductor to harvest — so the same failure can't quietly return next time it's worked.
- Surface the **cause, not the symptom**, with provenance: what was actually wrong, the **subsystem** it lives in, and the **run/episode** it came from. That provenance is what makes it recallable for the touched subsystem later.
- The conductor harvests it through the **existing `memory_write`** tool (it applies the write-bar + dedup-reinforce). **You surface; the conductor writes** — do not call memory yourself, and do not invent a new memory tool or schema. This is the seam, and it keeps the bug→gotcha→recall path one-directional.

### The escalation valve
Two failed fix attempts means the approach is wrong, not that the next guess will land. Stop: re-reproduce, re-read the evidence from scratch, or surface that you need context (an unfamiliar API, a file outside your boundary, an ambiguous contract). Undisciplined re-rolls burn the retry budget and add noise the verifier has to untangle.
