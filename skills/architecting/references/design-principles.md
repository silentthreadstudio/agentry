# Design Principles — depth

Reference for the `architecting` skill. Principles are means to one end: **code that is changeable** — easy to read, modify, and verify in isolation. Apply them when a concrete pressure calls for them, never preemptively.

## Cohesion and coupling (the foundation under SOLID)

- **Cohesion** — how related the things inside a module are. High cohesion = one clear responsibility. The test: can you describe the module without using "and"?
- **Coupling** — how much modules depend on each other's internals. Low coupling = each can change without breaking the other.
- **Goal:** high cohesion *within*, low coupling *across*. Most "bad architecture" is a cohesion or coupling failure wearing another name.

A **seam** is a boundary where two sides can change independently. Good seams sit at points of *volatility difference* — e.g., stable business logic vs. a volatile external API. Put your interfaces there.

## SOLID, ranked by leverage

**SRP — Single Responsibility (highest leverage).** A module has one reason to change. Reasons-to-change come from *actors*: the code that serves billing changes for billing reasons; code that serves reporting changes for reporting reasons; keep them apart. "And" in a module's description is the smell.

**DIP — Dependency Inversion.** High-level policy shouldn't depend on low-level detail; both depend on an abstraction. In practice: define an interface *at a real seam* (I/O, persistence, third-party service) so the volatile side swaps without touching the stable core. **Do not** invert where there is no seam — an interface with one forever-implementation is noise.

**OCP — Open/Closed.** Open to extension, closed to modification. Reach for it when a type is genuinely growing variants (a new payment method monthly). Premature OCP (a strategy pattern for two cases that never grow) is over-engineering.

**ISP — Interface Segregation.** Many small role-specific interfaces beat one fat one, so clients don't depend on methods they don't use. Apply when a fat interface forces unrelated clients to change together.

**LSP — Liskov Substitution.** Subtypes must be usable wherever the base is, without surprises. Mostly a correctness guard on inheritance; prefer composition and the problem rarely appears.

## When to abstract: YAGNI ↔ DRY

These pull in opposite directions; senior judgment is knowing which applies.

- **DRY** (don't repeat yourself) targets *knowledge* duplication — the same business rule in two places that must change together. Deduplicate that.
- **YAGNI** (you aren't gonna need it) targets *speculative* abstraction — generalizing for a future that may never arrive.
- **The reconciliation:** two pieces of code that *look* alike but change for *different reasons* are **not** a DRY violation — coupling them is the mistake. Duplication is cheaper than the wrong abstraction. Wait for the **third** occurrence before abstracting; two points don't define the shape.

## Dependency direction

Dependencies should point toward stability. Volatile things (UI, I/O, frameworks, external APIs) depend on stable things (domain logic, policy) — never the reverse. When you find the core importing from the edge, that's an inversion to fix (often the seam DIP is for).

## Right-sizing (the meta-principle)

Every principle above has a cost (indirection, more files, more concepts). Pay it only when the work returns the investment:

- A throwaway script: no patterns, one file is fine.
- A small feature in an existing module: follow local conventions, minimal new structure.
- A subsystem with real volatility and multiple actors: seams, SRP splits, a port at the I/O boundary.

Over-applying principles to small work *is itself* an anti-pattern — it produces the ceremony Agentry exists to avoid.
