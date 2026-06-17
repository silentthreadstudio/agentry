# Routing & Dispatch — depth

Reference for the `conducting` skill: how to right-size, what to dispatch, and where to gate.

## Signals → shape rubric

Read the prompt's shape first; investigate only if genuinely ambiguous. Bias to the floor.

| Signal | one-shot | spec-first | decompose+verify |
| :--- | :--- | :--- | :--- |
| **Specificity** | "done = X" is clear | vague ("make X better") | clear or clarified |
| **Scope** | one file/symbol | small, 1–2 files | many files/modules |
| **Reversibility** | trivially undoable | low risk | risky / high blast radius |
| **Unknowns** | none | maybe | real — research/explore upstream |
| **Decision-content** | no design choice — the *how* is obvious | a bounded design choice | the solution hinges on an undecided fork |
| **Precedent** | similar one-shots succeeded | similar needed clarifying | similar needed decomposition |

### The override — the *highest-severity* signal sets the floor, NOT the average

Signals are **not equal votes.** Take the **highest** shape any single signal justifies, then bias down only within what every signal allows. In particular, **`Unknowns: real` or `Decision-content: undecided fork` VETOES one-shot** → it forces **≥ spec-first regardless of `Scope`.** A task can be one or two files yet carry a load-bearing design choice; **small footprint ≠ small decision.** One-shotting it doesn't skip the decision — it makes it *silently and badly* (e.g. resolving an event's work-id by "newest-mtime folder" because no plan decided it). Decide forks in a spec/plan, not inside an edit.

> Worked example (the failure this rule exists to stop): *"emit events to events.jsonl"* reads as ~2 files → `Scope` says one-shot. But *where the log lives* and *how a per-tool-call hook learns the active work-id* is an **undecided fork** (`Decision-content` + `Unknowns`). Floor = **spec-first → plan gate**, not one-shot — and the fork is visible in the prompt up front, so escalate **before** touching code.

Pick the floor the override allows. Precedent is an input, not a mandate — a warm store sharpens this over time.

## Escalation triggers (pre-flight AND concrete mid-flight)

**Pre-flight (sets the initial floor):** before any edit, if a real unknown or an undecided design fork is already visible in the prompt, escalate *now* — don't wait for it to bite mid-task. The fork is usually visible up front.

**Mid-flight** — escalate one shape and re-enter at the smallest sufficient node when:
- the change touches **far more files** than the shape assumed,
- verify **fails twice** on the same task (don't burn a third undisciplined retry),
- a **real unknown** surfaces mid-task (unfamiliar API/lib) → route to research/explore,
- an **irreversible / high-blast-radius** step appears (migration, deletion, external write) → add a gate.

Never restart from scratch — re-enter where the work already is.

## Dispatch ladder

| Work | Mechanism | Why |
| :--- | :--- | :--- |
| one-shot | inline | no dispatch tax |
| medium → complex (default) | specialist subagents, parallel where contracts disjoint | isolated context, creative, returns distilled result |
| huge mechanical fan-out (rare) | dynamic workflow | scale + resumability; but fixed/uncreative — escape hatch only |

Parallel-safety: dispatch two implementers concurrently **iff** their task `contract.owns` are disjoint. Where they share a seam, serialize via `deps`. Consider `isolation: worktree` for parallel implementers so they can't clobber each other's working tree.

## Node ↔ specialist map

| Node (command) | Specialist | Produces |
| :--- | :--- | :--- |
| `/agentry:onboard` | explorer | Context map + seeded repo-facts |
| `/agentry:research` | researcher | Research (cited findings + implications) |
| `/agentry:spec` | product-owner | Spec (shaped) — conductor gates with user |
| `/agentry:plan` | architect | Plan (architecture map) + ADRs |
| `/agentry:split` | architect | Task contracts (sliced from the map) |
| `/agentry:implement` | implementer | code + tests (four-status return) |
| `/agentry:verify` | verifier | Verdict (per-AC PASS/FAIL + cited evidence) |
| `/agentry:assemble` | verifier | whole-product check vs Spec ACs |
| `/agentry:reflect` | librarian | reflect/distill + proposed facts/skills |
| `/agentry:remember` | (direct `memory_write`) | a captured fact |

UI/product work additionally routes the designer (no dedicated node required — dispatch it for UI cards and for the see-it review of rendered output).

## Gating points (and what they gate)

| Gate | When | Mechanism |
| :--- | :--- | :--- |
| **Spec gate** | under-specified work, before building | product-owner shapes the Spec → confirm "done = X" with the user |
| **Plan gate** | decompose+verify, before the build | verifier runs a *plan-lens* (falsifiable acceptance? contracts compose? riskiest first?) → user approves |
| **Ship gate** | assemble = MEETS | offer {commit+PR / iterate / reflect} |

In the Workbench (V2) these gates move out of chat: the human annotates the artifact and approves; the conductor reads the `.review/` sidecar at the next turn (doc 10). Until then, the **chat turn is the gate**.

## What flows where (thread information, don't re-derive)

- Recall subsystem memory **once**; thread it into every agent brief. Agents recall *narrowly*.
- Thread `research.md`'s implications into the spec + the architect's brief.
- When a verifier finding touches a **shared contract seam**, pause not-yet-started tasks on that seam and thread the finding into their briefs (cross-task propagation).
- Collect `used_memories` from each agent → `memory_feedback` at close.
