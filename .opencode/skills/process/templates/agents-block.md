## Agentry

This repo runs its work through Agentry's commands. Without Agentry installed, ignore this section.

- The process commands are `agentry board …` and `agentry lane …` (the plugin puts `agentry` on the PATH).
- Every session starts with `/agentry/start` and ends with `/agentry/close`.
- A task with a board id goes through `/agentry/exec <id>`.
- Landing a task's branch goes through `/agentry/merge <id>`.
- A question about the repo, a library or a design goes through `/agentry/ask <question>`.
- Before any change made outside these commands, recall first: `agentry mem recall --query "<the task>"`.
  Memory is `agentry mem …` (`write`, `search`, `feedback`, `stats`; `agentry mem --help` lists them).
- When the owner rejects or changes a proposal, or states a rule ("from now on…"), propose a draft in one line
  (`/agentry/board draft add`, then `--fields '{"kind":"decision","answer":"<the call>"}'`; `"kind":"rule"` for
  a standing rule). Drafts are confirmed at `/agentry/close`; never write one unconfirmed.
- The conductor prompt is `{prompt}`: read it at the start of every session and follow it.
