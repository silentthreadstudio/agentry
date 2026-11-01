---
description: Build one task whose contract is already written. `lane exec` cuts its worktree, writes the board, briefs a builder and an independent verifier round by round, and closes on a recorded gate with an episode. No spec, plan or split; no merge or push.
argument-hint: <task id, as written on the repo's board>
---

Run the **exec lane** for task `$ARGUMENTS`. The script carries the sequence: run the step it names and dispatch the prompt it prints, nothing else. The rules are in the `conducting` skill's `references/lanes.md`.

1. Only for an id matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` (otherwise ask first), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.mjs" exec start '<id>'` in the main checkout. Exit 2: show the message (contract candidates, open writers) and stop. Never guess a contract.
2. Read the printed JSON and act on `next`:
   - `build`, `verify`, `final`: dispatch a fresh agent with `prompt`, verbatim, as the whole prompt. `dispatch.agent` names the type (for a build it is a suggestion: you decide designer or implementer). No worktree isolation option: the worktree exists.
   - `fix`, `recheck`, `needs-context`, `resend`: when `mode` is `resume`, send `prompt` to the agent `agent` (resume it); otherwise dispatch fresh as above. For `needs-context`, do `todo` first.
   - `gate`, `close`: run `run` and read its exit code (a gate past the host's foreground limit: `lanes.md`, Dispatching).
   - `stop`: tell the owner `reason`, with every verdict (`lane exec show <id>`). Don't retry by hand.
   - `merge`: the lane is done; hand off (step 4).
3. When an agent returns, save its full reply to `reportPath` if that file is missing or empty, then run `after` with the agent's id. Back to step 2.
4. After `close`: call `episode_write` with `episode`, then run `afterwards` with the id it returns. Hand off: worktree, branch, verdicts, the gate record, and what's left (`/agentry:merge <id>`).

Show `guards` and `nested` whenever they are not empty. Lost track: `lane exec show <id>`. Not in this lane: right-sizing, spec, plan or split; Flow MCP calls; files under `.agentry/work/`; board edits by hand; merge and push.
