---
name: planning
description: This skill should be used when decomposing work into tasks — slicing an architecture map into bounded units, deriving each task's contract (the files/interface it owns), setting dependencies, sequencing the build, and checking that every acceptance criterion is covered. Loaded for decompose/split work, after a structure exists to slice.
version: 0.1.0
---

# Planning

Turn an approach and an architecture map into **bounded tasks** that are (1) **cold-resumable** — an agent opening a fresh session can execute one correctly, (2) **parallel-safe** — independent tasks can't clobber each other, and (3) **right-architecture** — each task inherits a clean boundary instead of inventing one mid-file. These three properties all come from one field: the **Contract**.

## The linchpin: the Contract

Each task declares the **public surface it owns**: which files/modules it touches (`owns`) and the interface it exposes (`exposes`). From this one field:

- **Parallelism is mechanical.** Two tasks run in parallel **iff their contracts don't overlap.** They serialize via `deps` only where they touch the same seam. Never guess parallel-safety — read it off the contracts.
- **No god-files.** The boundary is decided *before* code is written, so an agent can't sprawl into one 1000-line file.
- **Cold resume.** Contract + context pointers + acceptance let a fresh agent execute without re-reading the world.

Contracts are **sliced from the architecture map** (the `architecting` output): each module/interface on the map becomes the `owns`/`exposes` of one or more tasks. See `references/contracts-and-parallelism.md` for the derivation and overlap rules.

## Method

1. **Slice from the map.** Walk the architecture map; turn each component/seam into a task with a contract. Don't invent tasks the map doesn't imply.
2. **Right-size each task.** A task should be a coherent, independently verifiable unit — not so granular that overhead dominates, not so large it hides a god-file. Heuristic: one task = one contract a single agent can finish and verify alone.
3. **Set dependencies.** Add `deps` **only** where contracts overlap (a shared seam, an interface one task produces and another consumes). Everything else is parallelizable — leave it unblocked.
4. **Sequence.** Within the dependency order, do the **risky/uncertain step first** (fail cheap), and produce shared seams before their consumers.
5. **Cover the spec.** Build the criterion→task matrix: **every acceptance criterion must trace to ≥1 task** (`satisfies: [AC…]`). Flag any uncovered criterion before the build starts — this is the cheapest place to catch a dropped requirement.
6. **Make each task self-contained.** Fill Background (what + why), Contract, Gotchas (pre-filled from recalled memory for the owned files), Acceptance (independently checkable), Out-of-scope.

## Right-sizing the decomposition itself

Planning is also subject to floor-and-escalate. Don't decompose what doesn't need it: trivial work needs no tasks; medium work needs a few; only genuinely complex work earns a full split. A plan with ten tasks for a two-file change is the over-orchestration failure.

## Parallel-safety rules (summary)

- Non-overlapping `owns` → safe to run concurrently.
- Overlapping `owns`, or producer→consumer interface → `deps` edge, serialize.
- A task that edits a seam *owned by another task* is a planning error — re-slice so each seam has one owner.
- Prefer **interface-first ordering**: the task that defines a shared interface runs before its consumers.

Full treatment — contract derivation, overlap detection, finding propagation when a verifier changes a shared seam — in `references/contracts-and-parallelism.md`.

## Output

A set of Task documents (doc-01 format) with structured frontmatter (`id`, `status`, `owner`, `satisfies`, `deps`, `contract.owns`, `contract.exposes`) and the prose body, plus the criterion→task coverage matrix. Report any memory that shaped the decomposition in `used_memories`.

## Anti-patterns (refuse these)

- **Over-decomposition** — more tasks than the work needs; overhead beats value.
- **Overlapping contracts run in parallel** — silent clobbering; the parallelism bug.
- **Uncovered criterion** — an AC with no task; it never gets built (catch it at the matrix).
- **Vague acceptance** — a task whose "done" isn't independently checkable; it can't be verified alone.
- **Context-starved task** — no pointers/contract, so a cold agent can't execute it.

## Additional resources

### Reference files
- **`references/contracts-and-parallelism.md`** — deriving contracts from the architecture map, the overlap/`deps` rules, interface-first ordering, and cross-task finding propagation.
