---
name: architecting
description: This skill should be used when designing software structure — defining module boundaries and responsibilities, applying SOLID/SRP and separation of concerns, choosing a folder/layering structure, deciding when to abstract, recording an architectural decision (ADR), or judging whether a design is right-sized for the work. Loaded for design and decision tasks, not line-level edits.
version: 0.1.0
---

# Architecting

Design code structure that is **right-sized, repo-consistent, and bounded** — so the result is clean and changeable, not a 1000-line file with no seams. The craft is judgment, not dogma: the goal is the *least structure that keeps the work clear and changeable*, scaled to the task. **The symmetric failure is just as real:** under-structuring a genuinely complex change — no seams on a multi-actor subsystem — costs exactly as much as over-engineering a small one. The floor is set by the **hardest structural signal** (number of actors, volatility, blast radius), not by a bias toward less. Add the least structure that *meets that floor*, never less.

## The two rules that govern every design

1. **Right-sized.** Match structure to the work. Heavy patterns on a small task are over-engineering; no boundaries on a large one is the god-file. Add structure only when the work earns it.
2. **Repo-consistent.** Read the existing code and conventions first. Match what's there. Introduce a new pattern only with an ADR justifying it. A clever-but-foreign structure is worse than a plain-but-consistent one.

> **Override — consistency does not automatically win.** When matching the repo would *propagate an existing anti-pattern* (the established convention IS the god-file, the leaky boundary, the shotgun-surgery shape), that conflict is itself an **ADR-worthy fork**: name it and surface it, do not silently extend the bad pattern in the name of consistency. The floor is set by the harder of the two rules, not by a default to "match what's there."

## Method

Work in this order; stop early when the work is small enough not to need the later steps.

1. **Restate** the problem and its acceptance criteria in one line. If it can't be restated crisply, design is blocked — get clarity first.
2. **Map the existing shape.** What modules exist, how they're organized, what conventions are in force (naming, layering, error handling, test layout). Prefer a semantic code-intel tool to read structure fast.
3. **Find the boundaries the change needs.** Group by responsibility (things that change together live together; things that change for different reasons separate). Name each part's single responsibility.
4. **Check cohesion and coupling.** High cohesion inside a module, low coupling across. A seam is good when each side can change without the other.
5. **Decide forks → ADR — but a real fork is surfaced, not silently self-picked.** A trivial choice is a memory fact. A fork with **genuine alternatives AND lasting consequences** must be **surfaced for the gate** (recorded as an ADR and put in front of the user), or — if it hinges on an unknown — **routed to research** first. Do **not** resolve such a fork silently mid-design just because it's inside your owned structure: an undecided design fork vetoes the floor. Small footprint ≠ small decision.
6. **Express the structure** as the Plan's Architecture map: components, responsibilities, and the interfaces between them. This map is the source the `planning` skill slices Task contracts from.

## Applying SOLID with judgment

SOLID is a means to changeability, not a checklist to satisfy. The high-leverage ones:

- **SRP (single responsibility)** — the most useful. A module should have one reason to change. If you describe it with "and," consider splitting.
- **Dependency inversion** — depend on an interface at a real seam (e.g., the boundary to I/O, the DB, an external service), so the volatile side can swap without touching the stable side. Do **not** invert where there's no seam.

Apply the rest (open/closed, interface-segregation, Liskov) when a concrete pressure calls for them — never preemptively. See `references/design-principles.md` for the deep treatment, including cohesion/coupling and the **YAGNI ↔ DRY** balance.

## Choosing structure

- Default to the **simplest layering the repo already uses.**
- Reach for **ports-and-adapters (hexagonal)** when core logic must be insulated from volatile I/O and you need it testable in isolation — not by default.
- Keep the **dependency direction** pointing inward (stable core, volatile edges).

Folder/module conventions, layering patterns, and the full anti-pattern catalog (god-file, leaky abstraction, premature abstraction) are in `references/structure-and-antipatterns.md`.

## Decisions (ADR)

An ADR is required when **genuine alternatives exist OR the chosen structure deviates from established repo convention** (even an uncontested deviation — a new pattern with no competing option still needs the record that justifies departing). Record it. Default to a **Y-statement**:

> *In the context of (use case), facing (concern), we chose (option), to achieve (quality), accepting (downside).*

Always capture the **alternative rejected and why** — that is what stops the decision being re-litigated later. Expand to a full ADR (Context · Decision · Alternatives · Consequences · Links) only when consequences are large.

## Anti-patterns (refuse these)

- **God-file/module** owning unrelated responsibilities → split by reason-to-change.
- **Premature abstraction** — an interface with one implementation and no second caller in sight.
- **Over-engineering the small** — structure a one-shot would never need.
- **Convention drift** — a foreign pattern with no ADR.
- **Leaky boundary** — modules that reach across each other's internals.
- **Under-structuring the complex** — no seams on a multi-actor/volatile subsystem because the bias said "less"; the symmetric twin of over-engineering.
- **Silent fork-picking** — if you catch yourself choosing between real alternatives without writing an ADR or surfacing the fork, **stop**: that's the silent-guess failure.

## Output

A Plan with an Architecture map sharp enough that `planning` can slice non-overlapping Task contracts from it, plus any ADRs. Report any memory that changed the design in `used_memories`.

## Additional resources

### Reference files
- **`references/design-principles.md`** — SOLID/SRP in depth, cohesion & coupling, when-to-abstract (YAGNI vs DRY), dependency direction.
- **`references/structure-and-antipatterns.md`** — folder/module conventions, layering & hexagonal patterns, and the full anti-pattern catalog with fixes.
