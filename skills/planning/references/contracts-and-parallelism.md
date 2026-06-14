# Contracts & Parallelism — depth

Reference for the `planning` skill: how to derive Task contracts from an architecture map, detect overlap, order the build, and propagate findings safely.

## Deriving a contract from the architecture map

Each component/seam on the architecture map becomes one or more tasks. For each, fill:

- **`owns`** — the concrete files/modules this task creates or modifies. Be specific (`auth/middleware.ts`), not vague (`the auth stuff`). Specificity is what makes overlap detectable.
- **`exposes`** — the public interface other tasks depend on (a function signature, a type, an endpoint, an event). This is the *contract with the rest of the system*.

A task's `owns` should be **disjoint** from every other task's `owns` wherever possible. Where two tasks genuinely must touch the same file, that file is a shared seam → they get a `deps` edge and serialize.

## Overlap detection (the parallel-safety rule)

```
parallel-safe(A, B)  ⟺  owns(A) ∩ owns(B) = ∅  AND  neither consumes an interface the other has not yet exposed
```

- **Disjoint `owns`, no producer/consumer link** → run concurrently.
- **Overlapping `owns`** → `deps` edge; serialize (one owner edits, the other waits).
- **Producer→consumer** (A `exposes` what B imports) → `deps: [A]` on B; A runs first.

If two tasks *must* edit the same symbol, that's a **slicing error** — re-cut so each seam has exactly one owner, or merge the two tasks. Never let two parallel tasks own the same line.

## Interface-first ordering

When a shared interface exists, the task that **defines** it runs before the tasks that **consume** it. This lets consumers code against a stable signature instead of a moving target, and keeps the dependency graph shallow. Within the unblocked set, run the **riskiest/most-uncertain task first** so failures surface while they're cheap to absorb.

## Coverage matrix

Before any code is written, build the criterion→task matrix:

| Acceptance criterion | Covered by |
| :--- | :--- |
| AC1 | T-001 |
| AC2 | T-003, T-004 |
| AC3 | — ⚠️ uncovered |

Any criterion with no task is a dropped requirement — the cheapest place to catch it is here, not after assemble. Add a task or explain the gap before proceeding.

## Cross-task finding propagation

During the build, a verifier may return a finding that touches a **shared seam** (a contract other not-yet-started tasks depend on). When that happens:

1. Pause the not-yet-started tasks that own or consume that seam.
2. Thread the finding into their Background/Gotchas.
3. Record it on the work item so the propagation is visible.

This prevents parallel tasks from building against a contract that just changed under them. It is the reason `deps` track *contracts*, not just files: a contract change ripples to every consumer.

## Task-sizing heuristics

- **Too big** if: it owns many unrelated files, or its acceptance can't be checked in one pass → split.
- **Too small** if: its overhead (context, dispatch, verify) rivals the work itself → merge into a sibling.
- **Right** when: one agent can finish it, verify it **alone** against its acceptance, and hand back a result without needing another task's output mid-flight.

## Cold-resumability check

Before finalizing a task, ask: *could a fresh agent with empty context execute this correctly from the task file alone?* It can iff the file carries Background (what+why), Contract (the boundary), Gotchas (recalled warnings), Acceptance (how to know it's done), and pointers to the files/ADRs it needs. If not, the task is context-starved — fill the gap.
