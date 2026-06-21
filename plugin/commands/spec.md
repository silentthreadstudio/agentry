---
description: Turn a goal — especially an under-specified one ("make X better") — into a crisp Spec with observable acceptance criteria. The "done = X" gate before building.
argument-hint: <the goal / feature ask>
---

Dispatch the **product-owner** subagent to shape a Spec for: `$ARGUMENTS`.

Brief for the product-owner:
- Capture the problem/intent (JTBD), scope + **explicit non-goals**, constraints, and context.
- Write **observable, verifiable** acceptance criteria (`AC1..n`) — checkable by behavior, not vibes. These will trace to tasks and drive assemble.
- Define needs, not solutions; don't gold-plate.

Output: a **Spec** (doc-01 format) written via the Flow MCP if present — `artifact_write(run, kind:"spec")` (persists at `.agentry/work/<id>-<slug>/spec.md`).

**Then gate:** present "done = X" (the acceptance criteria) to the user and confirm before any building begins. The spec gate is the conductor's job — workers can't do it.
