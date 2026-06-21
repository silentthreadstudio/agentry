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

## Pre-flight gate (before you slice)

Planning slices what the architecture map *bounds* — it does not invent the boundaries. **If the map has un-bounded seams, or it can't yield disjoint contracts, planning is BLOCKED** — surface it back to architecting; do **not** draw boundaries the map doesn't imply. The same rule architecting runs on itself applies here: if the structure can't be sliced crisply into owned surfaces, the design isn't ready to plan against.

## Method

1. **Slice from the map.** Walk the architecture map; turn each component/seam into a task with a contract. Don't invent tasks the map doesn't imply.
2. **Right-size each task.** A task should be a coherent, independently verifiable unit — not so granular that overhead dominates, not so large it hides a god-file. Heuristic: one task = one contract a single agent can finish and verify alone.
3. **Set dependencies.** Add `deps` **only** where contracts overlap (a shared seam, an interface one task produces and another consumes). Everything else is parallelizable — leave it unblocked. **When overlap is ambiguous, the conservative default is SERIALIZE** — add the `deps` edge. Never parallelize on an *unproven* assumption of disjointness; a wrong guess silently clobbers, and serializing only costs time.
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

A set of Task documents, one per slice, **authored as plain markdown** — `## Goal` · `## Contract` · `## Acceptance` · `## Out of scope` — plus the criterion→task coverage matrix. The **Contract** section carries `owns`/`exposes`/`excludes`/`deps`/`satisfies` — as prose bullets, or a fenced `yaml` block *inside* `## Contract` — so coverage and parallel-safety stay machine-checkable. **Do not hand-write a `---` frontmatter block:** `task_create` is the single frontmatter authority (next paragraph); a leading `---` in the body stacks into a *double frontmatter* that renders as a broken blob in the Workbench. Each task body carries its **must-not-touch** boundary, **pinned** names for any surface a sibling consumes, and the **leave-it-green** verify/build steps (discovered from the repo, never hardcoded) — see the reference. Report any memory that shaped the decomposition in `used_memories`.

**Emit each slice through FLOW — `task_create(run, title, body)` per task.** When the split runs as part of an escalated run, write each Task contract via the **`flow` MCP** `task_create` call (threading the `run` handle the conductor holds from `run_start`), not a raw hand-written file. You supply the `title` and the **plain-markdown `body`**; Flow stamps the single frontmatter (`title`, `status: todo` from the closed status enum, the content-hash `version`) — correct by construction, so the status vocabulary can't drift. The **contract lives in the body's `## Contract` section, not in frontmatter** — Flow owns the one frontmatter block. (This is the planning half of the FLOW mandate; the conducting skill mandates `task_assign`/`task_status` for the lifecycle. As ever, this applies **above the one-shot floor only** — a one-shot writes no task files at all.)

**Canonical task body** — exactly what you pass as `body` (Flow prepends the frontmatter; the body opens at `## Goal`, never `---`):

~~~markdown
## Goal
<one-line outcome>

## Contract
```yaml
owns:    [path/a.ts, path/b.ts]
exposes: ["fnName(x) -> Y"]
excludes: [path/c.ts]
deps:    [T-001]
satisfies: [AC2]
```

## Acceptance
- <observable, independently checkable>

## Out of scope
<what this task must not touch>
~~~

## Anti-patterns (refuse these)

- **Over-decomposition** — more tasks than the work needs; overhead beats value.
- **Under-decomposition** — the symmetric failure: one task owning many unrelated files; it becomes the god-file the contract was meant to prevent.
- **Overlapping contracts run in parallel** — silent clobbering; the parallelism bug. When overlap is unclear, serialize — never guess disjoint.
- **Inventing boundaries the map doesn't imply** — slicing on past un-bounded seams instead of blocking back to architecting.
- **Uncovered criterion** — an AC with no task; it never gets built (catch it at the matrix).
- **Unverified-state assumption** — a task that asserts the repo is already in some state ("the script is absent", "no fixtures dir") the architect never checked. Have the task *verify and adjust*, not act on a guess — an assumed-absent thing that's present-but-wrong silently breaks the build.
- **Vague acceptance** — a task whose "done" isn't independently checkable; it can't be verified alone.
- **Context-starved task** — no pointers/contract, so a cold agent can't execute it.

## Additional resources

### Reference files
- **`references/contracts-and-parallelism.md`** — deriving contracts from the architecture map, the overlap/`deps` rules, interface-first ordering, and cross-task finding propagation.
