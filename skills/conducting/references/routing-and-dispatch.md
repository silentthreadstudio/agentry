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
| **Precedent** | similar one-shots succeeded | similar needed clarifying | similar needed decomposition |

Pick the **lowest** row the signals justify. Precedent is an input, not a mandate — a warm store sharpens this over time.

## Escalation triggers (concrete)

Escalate one shape and re-enter at the smallest sufficient node when:
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

In the Workbench (V2) these gates move out of chat: the human annotates the artifact and approves; the conductor reads the `.review/` sidecar at the next turn (doc 08). Until then, the **chat turn is the gate**.

## What flows where (thread information, don't re-derive)

- Recall subsystem memory **once**; thread it into every agent brief. Agents recall *narrowly*.
- Thread `research.md`'s implications into the spec + the architect's brief.
- When a verifier finding touches a **shared contract seam**, pause not-yet-started tasks on that seam and thread the finding into their briefs (cross-task propagation).
- Collect `used_memories` from each agent → `memory_feedback` at close.
