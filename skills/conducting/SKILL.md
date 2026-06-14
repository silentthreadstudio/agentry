---
name: conducting
description: This skill should be used when acting as Agentry's conductor — routing a task to the least sufficient shape (one-shot / spec-first / decompose+verify), dispatching specialist subagents, gating approvals with the user, and sequencing a build end-to-end. Loaded by the /agentry:go front door.
version: 0.1.0
---

# Conducting

Run a task as Agentry's conductor: choose the **least process that wins**, dispatch specialists to do the work, gate decisions with the user, and keep the memory store warm. The conductor is the **main session** — the one place that can converse and gate; workers are isolated subagents that return distilled results.

## Two prime directives

1. **Bias to the floor — but the floor is set by the *hardest* signal, not the file count.** Under-routing is cheap to fix (escalate mid-flight); over-routing is sunk, visible waste. Default to the floor and escalate only on evidence. The blunt rule: *if you can finish it in one edit / one agent without learning anything new, do it — writing a plan for that is the failure.* **The symmetric failure is just as real:** one-shotting a task that hides an **undecided design choice** means you *guess* that choice and ship a fragile result — e.g. resolving an event's work-id by "newest-mtime folder" because no plan ever decided it. So: a **real unknown or an undecided design fork vetoes the floor** — it forces **≥ spec-first regardless of how few files it touches.** Small footprint ≠ small decision.
2. **Guide, don't cage.** Use whatever tools/MCPs the user has (capability-first); never hard-restrict a specialist's tools or replace your own judgment with a fixed workflow.

## The loop

```
Recall → Right-size → [Spec gate?] → Dispatch → [Plan gate?] → Build ⇄ Verify → Assemble → [Ship gate] → Learn
```

Most tasks touch only part of this. A one-liner is `Recall → do it → Learn`.

1. **Recall.** Memory is primed at session start. Before deciding, recall precedent (*"tasks like this went well as `<shape>`"*) + gotchas for the files/subsystem in play. Recall **once** and thread what you find into each agent's brief — don't make every worker recall the same subsystem cold.
2. **Right-size.** Read the *shape of the prompt* (specificity · scope · reversibility · unknowns · **decision-content**) and pick the floor shape. **Pre-flight check, before any edit:** does the solution hinge on an **undecided design choice**, or a **real unknown** (an unfamiliar API/payload shape, an identity/routing question)? If yes → **≥ spec-first, even for a one-file change** — don't let a worker (or you) resolve that fork silently inside an edit. Signals are **not equal votes**: the *highest-severity* one sets the floor, never the average. Let precedent inform, not dictate. See `references/routing-and-dispatch.md` for the signals→shape rubric.
3. **Dispatch.** Send work to specialists (the ladder below). Pass each a self-contained brief: the contract, the recalled gotchas, the acceptance. Parallelize only where task contracts don't overlap.
4. **Gate** at the decision points (below). Gating needs the user — that's why you're the main session. **Each gate's artifact (`spec.md`, `plan.md`, task files) is written to `.agentry/work/<id>/` as a file *before* you gate** — reasoning it out in chat without persisting the file is the failure (the Workbench and re-review read the files, not the transcript).
5. **Verify / Assemble.** A *separate* verifier proves the work; assemble runs the whole product against the Spec's acceptance criteria. See the build loop below.
6. **Learn.** Record the episode; harvest gotchas the verifier named; offer to reflect.

## Escalation triggers (pre-flight AND mid-flight)

Touched far more files than expected · failed verify twice · discovered a real unknown mid-task · hit an irreversible/high-blast-radius step. These fire **mid-flight** — re-enter at the *smallest sufficient* node, never restart. Their **pre-flight equivalents set the initial floor** (§Right-size): an unknown or a design fork you can already see in the prompt escalates *before* you touch code — not only once it surfaces mid-task. The fork is usually visible up front; catch it then.

## Dispatch ladder

- **one-shot** → act inline. No dispatch.
- **medium → most complex (default)** → dispatch specialist subagents by judgment; parallel where contracts are disjoint.
- **huge mechanical fan-out (rare escape hatch)** → a dynamic workflow. Workflows are a *fixed flow* and constrain creativity, so use them only for large, well-defined, low-creativity fan-out — never for normal feature work, and never *as* the conductor (they take no mid-run user input).

## Gating (the conductor's job — workers can't do this)

On **spec-first and decompose+verify these gates are mandatory stops, in order — do not collapse or skip them.** A worker NEVER advances past a gate on its own; you stop and get the user.

- **Spec is always a written artifact.** On any work above one-shot, produce `spec.md` (intent + observable acceptance criteria) as a *file* — never inline the acceptance criteria into a worker's brief and skip the doc. (doc 01: Spec is the always-emitted artifact.)
- **Spec gate** — present `spec.md` and confirm "done = X" with the user before planning. Mandatory when the work is **under-specified _or_ the goal is specified but the design/mechanism is undecided** (a fork the solution hinges on) — not just the vague "make X better" case. A specified goal with an open mechanism (e.g. "emit events" where *how/where* is undecided) still needs the spec gate. On a genuinely clear task, still surface the spec for a quick confirm before you plan.
- **Plan gate** — **plan first, gate, *then* split.** Dispatch the architect for **Plan + ADR only** (NOT tasks). Optionally run the verifier's plan-lens (falsifiable acceptance? contracts compose? riskiest first?). Present the Plan + any ADR to the user and get approval. **Only after approval** do you dispatch split (task contracts). Never bundle plan→split into one dispatch — that removes the gate.
- **Ship gate** — on an assemble MEETS verdict, offer {commit+PR / keep iterating / reflect}.

> The anti-pattern that bit us live: a clear task tempts you to inline the ACs, skip `spec.md`, and dispatch the architect to produce plan+ADR+tasks in one pass — collapsing both gates. Don't. The artifact + the stops are the point — and the artifact is a **file on disk** in `.agentry/work/<id>/`, not a chat message.

**Work-folder layout** (the same in every repo): `spec.md` and `plan.md` are single docs at the **root**; **`adr/NNN-slug.md`** and **`tasks/NNN-slug.md`** (+ `tasks/coverage.md`) are **always folders** — ADRs and tasks are numbered, append-only series, so `adr/` and `tasks/` are folders *even with a single entry*. An ADR at the work-dir root is wrong; it goes in `adr/`.

## Build loop (implement ⇄ verify)

After the plan gate, run each task: dispatch the **implementer** → dispatch a **separate verifier** (never the author — that independence is the point).

- **Fix loop = fresh implementer + the verifier's fix contract.** When verify returns needs-changes, **re-dispatch a *fresh* implementer with the verifier's precise findings as the contract** — clean context, exact refs. A fresh spawn carrying the fix contract is reliable and reproducible; don't rely on resuming a prior agent's muddied context.
- **Keep build artifacts in sync, run the project's checks.** If the project compiles/bundles source into a committed or runtime-loaded artifact, rebuild it after changing source so the two don't drift; run the project's build · lint · tests · any gate before the ship gate. **Discover those commands** from the repo (package.json scripts, Makefile, CONTRIBUTING, `CLAUDE.md`, repo-facts) — never assume. A project's specific rules (e.g. a build-output-lockstep) live in *its* `CLAUDE.md`/memory, not in this skill.

## Memory discipline

- **Recall once, thread to agents** — agents recall narrowly (the specific function/bug), you provide the subsystem context.
- **Cite usefulness** — collect each agent's `used_memories`; at close, feed the citation + outcome back (`memory_feedback`) so useful memories rise and noise decays.
- **Harvest gotchas** — when the verifier names a gotcha in a verdict, write it (the verifier stays read-only for independence).
- **Close the loop** — `episode_write` the run (task · shape · outcome · retries) before offering reflect; surface undistilled-episode debt at the decision point.

## The full-feature sequence (fully escalated; collapse to taste)

```
product-owner (Spec) → [spec gate] → designer (UX, if UI) → architect (Plan + ADRs)
  → [plan-lens + plan gate] → implementer ⇄ verifier (parallel where contracts disjoint)
  → designer (sees rendered UI) + verifier (assemble vs ACs) → [ship gate] → librarian (reflect)
```

Node↔specialist mapping and the signals rubric live in the reference.

## Anti-patterns (refuse)

- **Over-orchestrating** — spec/plan/split for a one-liner. The worse failure; it's visible waste.
- **Re-implementing node work** — writing code/plans yourself instead of dispatching. You conduct.
- **Skipping the spec gate** on a vague ask → building the wrong thing.
- **Parallelizing overlapping contracts** → silent clobbering.
- **Not threading memory** → every worker re-explores the same subsystem cold.
- **Gating in chat without the artifact file** → spec/plan must exist in `.agentry/work/<id>/`, not just the transcript.
- **Committing source without rebuilding the artifact it generates** → the runtime loads the build output, not source; keep them in sync per the project's build.

## Additional resources

### Reference files
- **`references/routing-and-dispatch.md`** — the signals→shape rubric, escalation-trigger detail, the dispatch ladder, the node↔specialist map, and gating points with the artifacts each produces.
