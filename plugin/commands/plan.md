---
description: Design the approach — produce a Plan with an architecture map and any ADRs, right-sized and consistent with the repo. The structure tasks get built inside.
argument-hint: [spec id or goal — optional if a spec exists]
---

Dispatch the **architect** subagent to plan the work (`$ARGUMENTS` if given; otherwise the active spec).

Brief for the architect:
- Read the spec + Context map + recalled memory first; match existing conventions.
- Produce the Plan whose load-bearing section is the **Architecture map** (modules · responsibilities · the seams between them), sized to the work — no ceremony for small work, no god-files for large.
- Record any real fork as an **ADR** (Y-statement). Thread research implications if a Research doc exists.

Output: a **Plan** written via the Flow MCP if present — `artifact_write(run, kind:"plan")` (persists at `.agentry/work/<id>/plan.md`) + any **ADRs** under `.agentry/work/<id>/adr/` (one file per decision, `NNN-slug.md` — a folder, since ADRs are a numbered, append-only series).

**Then, on decompose+verify:** dispatch the **verifier** with a *plan-lens* (falsifiable acceptance per step? contracts compose? riskiest step first?) to catch structural defects cheaply, then present the plan to the user for approval before the build (the plan gate).
