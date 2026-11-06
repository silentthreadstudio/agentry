---
# Generated from plugin/commands/spec.md by scripts/build-opencode.mjs — edit the source, not this file.
description: Turn a goal — especially an under-specified one ("make X better") — into a crisp Spec with observable acceptance criteria. The "done = X" gate before building.
---

Dispatch the **product-owner** subagent to shape a Spec for: `$ARGUMENTS`.

Brief for the product-owner:
- Capture the problem/intent (JTBD), scope + **explicit non-goals**, constraints, and context.
- Write **observable, verifiable** acceptance criteria (`AC1..n`) — checkable by behavior, not vibes. These will trace to tasks and drive assemble.
- Define needs, not solutions; don't gold-plate.

Output: a **Spec** written as a plain file at `.agentry/work/<run>/spec.md`, one frontmatter block (`title`, `status: draft`, `kind`, `shape`) — the work-folder layout in the `conducting` skill. When the conductor already wrote `spec.md`, the product-owner keeps its existing frontmatter and the routing line under it.

**Then gate:** present "done = X" (the acceptance criteria) to the user and confirm before any building begins. The spec gate is the conductor's job — workers can't do it.
