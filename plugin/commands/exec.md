---
description: Build one task whose contract is already written. `agentry lane exec` cuts its worktree, writes the board, briefs a builder and an independent verifier round by round, and closes on a recorded gate with an episode. No spec, plan or split; no merge or push.
argument-hint: <task id, as written on the repo's board>
---

Run the **exec lane** for task `$ARGUMENTS`. The script carries the sequence: run the step it names and dispatch the prompt it prints, nothing else. The rules are in the `conducting` skill's `references/lanes.md`.

Shell calls use `agentry`, the plugin's `bin/` command; where it is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (or `lane.mjs`) with the same arguments.

1. Only for an id matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` (otherwise ask first), run `agentry lane exec start '<id>'` in the main checkout. Exit 2: show the message (contract candidates, open writers) and stop. Never guess a contract.
2. Read the printed text (`--json` prints the same fields as one object) and act on `next`. After `start`, check the `owned` list against the contract; a wrong list is fixed with the `amend` line (`agentry lane exec owns <id> --set <paths> --apply`), which also rewrites the waiting brief:
   - `build`, `verify`, `final`: dispatch a fresh agent with `prompt`, verbatim, as the whole prompt. `dispatch.agent` names the type (for a build it is a suggestion: you decide designer or implementer). No worktree isolation option: the worktree exists.
   - `fix`, `recheck`, `needs-context`, `resend`: when `mode` is `resume`, send `prompt` to the agent `agent` (resume it); otherwise dispatch fresh as above. For `needs-context`, do `todo` first.
   - `gate`, `close`: run `run` and read its exit code (a gate past the host's foreground limit: `lanes.md`, Dispatching).
   - `stop`: tell the owner `reason`, with every verdict (`agentry lane exec show <id>`). Don't retry by hand.
   - `merge`: the lane is done; hand off (step 4).
3. When an agent returns, save its full reply to `reportPath` if that file is missing or empty, then run `after` with the agent's id. Back to step 2.
3b. A verdict of `PASS WITH NOTES` whose notes are worth fixing in this lane: before `close`, run `agentry lane exec fix '<id>' --notes N1,N3` (the labels in the verifier's report) and carry on from step 2.
4. `close` also works on a merged or stopped lane (to clear a pending episode). After `close`: call `episode_write` with `episode`, then run `afterwards` with the id it returns. Hand off: worktree, branch, verdicts, the gate record, and what's left (`/agentry:merge <id>`).

Show `guards` and `nested` whenever they are not empty. Lost track: `agentry lane exec show <id>`. Not in this lane: right-sizing, spec, plan or split; Flow MCP calls; files under `.agentry/work/`; board edits by hand; merge and push.
