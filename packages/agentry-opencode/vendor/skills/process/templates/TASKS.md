# Debt

One light contract per debt item, outside the sprints: the files it owns and one acceptance line.
`/agentry:exec DEBT-1` builds it and `/agentry:merge DEBT-1` lands it, as for a task.

### DEBT-1 · The first cleanup
- **Owns:** `docs/work/TASKS.md`
- **Acceptance:** what a reviewer runs or sees to call it done

# Task contracts

One block per task, under its sprint's heading. A task leaves `todo` only once its block names the files
it owns, what it exposes and how a reviewer sees it works.

## S1 · First sprint

### T1 · The first task
- **Owns:** the files this task may change
- **Exposes:** what other tasks can rely on once it lands
- **Acceptance:** what a reviewer runs or sees to call it done
