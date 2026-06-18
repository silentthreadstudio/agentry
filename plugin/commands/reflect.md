---
description: Curate memory and distill the run's episodes into durable facts after a piece of work — keeps the moat warm. Proposes skills (human-gated), never installs them.
argument-hint: [scope hint — optional]
---

Dispatch the **librarian** subagent to reflect and distill (`$ARGUMENTS` for scope if given).

Brief for the librarian:
- **Reflect:** resolve contradictions, supersede stale facts (mark + link, never delete), confirm low-confidence claims.
- **Distill:** cluster the run's undistilled episodes → extract durable semantic facts, each citing its source episodes (provenance); dedup-reinforce instead of duplicating; stamp episodes `distilled`.
- **Consolidate:** if a pattern recurs across tasks above the usefulness floor, **propose** a skill (with provenance) — do **not** install it.

Output: proposed facts (auto-write through the bar) + any skill **proposals**.

**Then gate skills with the user:** a skill modifies their Claude Code config — present each proposal for approval before it's written. Facts need no gate; decay keeps them clean.
