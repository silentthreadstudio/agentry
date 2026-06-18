# Structure & Anti-patterns — depth

Reference for the `architecting` skill: how to organize code, and the failure modes to refuse.

## Choosing a structure

**Default: match the repo.** Before proposing any structure, read how the codebase already organizes itself (by layer? by feature? by domain?) and follow it. Consistency beats cleverness. Introduce a new structure only with an ADR.

Common organizing axes:

- **By layer** (controllers / services / repositories) — familiar, fine for small/CRUD apps; degrades as features cut across layers.
- **By feature/domain** (each feature owns its slice top-to-bottom) — scales better for larger apps; changes stay local to one folder.
- **Ports-and-adapters (hexagonal)** — a stable core (domain + use-cases) surrounded by adapters for I/O (DB, HTTP, queues). Reach for it when the core must be testable in isolation and insulated from volatile infrastructure. Not a default — it costs indirection.

**Dependency rule (any structure):** dependencies point inward/toward stability. The core never imports an adapter; adapters import the core. Enforce the direction, not a specific folder name.

## Module boundary checklist

A boundary is well-placed when:
- it has **one responsibility** (describable without "and"),
- each side can **change without the other** (the seam holds),
- its **public surface is small** (few exposed symbols), and
- its name says what it *does*, not how it's *built*.

If a "module" is just a bag of unrelated helpers, it has no boundary — split or absorb it.

## The anti-pattern catalog (refuse, and name the fix)

| Anti-pattern | Symptom | Fix |
| :--- | :--- | :--- |
| **God-file / god-module** | one file/class owns unrelated responsibilities; grows without limit | split by reason-to-change (SRP); extract cohesive units |
| **Premature abstraction** | an interface/base with one implementation and no second caller in sight | inline it; wait for the 3rd real occurrence |
| **Over-engineering the small** | patterns/layers on work a one-shot would finish | delete the ceremony; one file, direct code |
| **Leaky abstraction** | callers must know the internals to use it correctly | redesign the interface to hide what leaks |
| **Convention drift** | a foreign structure introduced without justification | match the repo, or write an ADR for the new pattern |
| **Shotgun surgery** | one logical change forces edits in many scattered places | the knowledge is duplicated/misplaced — consolidate it |
| **Circular dependency** | modules import each other | extract the shared piece, or invert one direction at a seam |
| **Anemic boundary** | a "module" that's just unrelated utilities | give it a responsibility or distribute its contents |

## How structure feeds tasks

The architecture map produced here is the **source the `planning` skill slices Task contracts from**. A well-bounded map → clean `contract.owns`/`exposes` per task → mechanical parallel-safety. A vague map → overlapping contracts → unsafe parallel work. The quality of the boundaries *here* determines whether the build can parallelize *there*. Design the seams as if someone will slice tasks along them — because they will.
