---
description: Build one task — clean, bounded code (and tests) within its contract. Dispatches the implementer with the task's brief.
argument-hint: <task id>
---

Dispatch the **implementer** subagent to build task `$ARGUMENTS`.

Brief for the implementer:
- Stay **inside `contract.owns`** — no sprawl, no god-file. Match repo conventions.
- Read the task's Background, Contract, Gotchas (recalled warnings), and Acceptance; recall narrowly for the specific function/bug if needed.
- Write tests against the contract/behavior; satisfy the task's Acceptance.
- Return via the **four-status protocol**: `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`, plus `used_memories`.

Lifecycle runs through the Flow MCP if present — the conductor assigns the task with `task_assign(run, …)` and moves it through `task_status(run, …)` as the implementer reports (so the run stays resumable and visible in the Workbench); the build itself persists under `.agentry/work/<id>/…`.

For parallel tasks with disjoint contracts, dispatch implementers concurrently (consider `isolation: worktree` so they can't clobber each other). Route the returned status: `DONE` → verify; `NEEDS_CONTEXT`/`BLOCKED` → resolve before retrying.
