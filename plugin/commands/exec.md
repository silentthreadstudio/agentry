---
description: Build one task whose contract is already written — find it, brief a builder in a worktree, verify it independently, hand off. No spec, plan or split; no merge or push.
argument-hint: <task id, as written in the repo's task file>
---

Run the **exec lane** for task `$ARGUMENTS`. The contract exists: build it, verify it, hand it off. The brief templates and edge cases are in the `conducting` skill's `references/lanes.md`; the essentials:

1. **Find the contract.** Only for an id matching `^[A-Za-z0-9._-]+$` (otherwise ask first), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/find-contract.mjs" '<id>'`. On `found`, its `block` is the contract. On `not-found` or `ambiguous`, show the candidates (`file:line`) and ask which one is meant; if the script is missing or fails, say so and ask for the file. Never guess a contract, never write one.
2. **Brief one builder** with `isolation: "worktree"`: the **designer** when the contract is UI-shaped, else the **implementer**. The brief's first line is exactly `agentry-task: <id> role=build`; it carries the block verbatim, its owned files, its acceptance, the decisions it cites and the gotchas you recall for its files.
3. **Route the report.** `DONE` / `DONE_WITH_CONCERNS` → verify. `NEEDS_CONTEXT` → if the missing fact is already in the contract block, the repo or recalled memory, supply it and re-dispatch once (a new dispatch, marker first), else stop and ask the owner; `BLOCKED` → stop and report. Never widen the contract.
4. **Verify independently** with a fresh **verifier**, never the builder, in the builder's worktree. The brief's first line is exactly `agentry-task: <id> role=verify`; its last instruction is that the report's final line is exactly `Verdict: PASS | PASS WITH NOTES | FAIL`.
5. **On `FAIL`**, dispatch a fresh builder once with the verdict as its fix list, then verify again. A second `FAIL` stops the lane: report both verdicts to the owner.
6. **Hand off:** worktree path, branch, commits, the verdict, what's left.

Not in this lane: right-sizing, spec, plan or split; Flow MCP calls; files under `.agentry/work/`; edits to the repo's board or task status; merge and push (the owner merges).
