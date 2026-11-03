---
description: Open the session the same way every day — the conductor prompt, derived status with drift nudges and pending drafts, recall for the work in flight, the active mode and the owner's open questions, as five lines and one recommendation.
---

Start the session. Run `agentry lane` from the main checkout, in the foreground. The details of every field: the `conducting` skill's `references/session.md`.

Shell calls use `agentry`, the plugin's `bin/` command; where it is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (or `lane.mjs`) with the same arguments.

1. Run `agentry lane session start`. Exit 2 with a missing process file → say so, point to `/agentry:init`, stop. It prints at most 40 lines: the conductor prompt's path, the mode, the Now sprint, what is in flight and on the owner, drift, pending drafts, the lanes' ledgers and recalled facts. For the full object add `--json`.
2. Read the conductor prompt it names, once. Skip the read if you already did this session. Follow its rules and the printed mode for the rest of the session (the mode skill `mode-<name>`, if the repo has one).
3. Tell the owner, in five lines at most: where the Now sprint stands, what is in flight, what waits on them, the drift worth acting on (each row already names its command), and the pending drafts or open questions. Use the printed words; invent nothing.
4. End with one recommendation: the single next step, usually the command a drift row names, `/agentry:exec <id>` for the next task whose deps are done, or `/agentry:close` when only drafts are left.

Use a recalled fact only where it applies to the work in flight, and cite its id. Never edit the board, never commit, never start work before the owner picks the next step.
