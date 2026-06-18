---
description: Capture a durable memory now — a gotcha, decision, preference, or repo-fact. Goes through the write-bar and dedup-reinforce; no subagent needed.
argument-hint: <the thing to remember>
---

Capture this as a durable memory: `$ARGUMENTS`.

Do it directly with `memory_write` (no subagent):
- **Classify** the `type` (gotcha · decision · preference · repo-fact) and `scope` (user/global vs repo). A team/personal preference like "always use PNPM" → `global`; a fact about this codebase → `repo`.
- **Apply the write-bar:** capture it only if it will change a future decision. If it's transient bookkeeping, say so and skip.
- **Dedup-reinforce:** if a near-duplicate already exists, the write reinforces it rather than creating a copy — report which.
- Include a `why` for gotchas/decisions.

Confirm what was written (or reinforced) with its id and type.
