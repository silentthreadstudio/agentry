---
description: Open the session the same way every day — the conductor prompt, derived status with drift nudges and pending drafts, recall for the work in flight, the active mode and the owner's open questions, as five lines and one recommendation.
---

Start the session. Run `agentry lane` from the main checkout, in the foreground. The details of every field: the `conducting` skill's `references/session.md`.

Shell calls use `agentry`, the plugin's `bin/` command; where it is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (or `lane.mjs`) with the same arguments.

1. Run `agentry lane session start`. Exit 2 with a missing process file → say so, point to `/agentry:init`, stop. It prints at most 40 lines: the conductor prompt's path, the mode, the lanes held for the owner (`held:`, with the evidence and the resume step) or parked, the idle lanes, the Now sprint, what is in flight and on the owner, drift, pending drafts, the repo's start checks still to run and how the last close's checks went (`start checks:`, `last close:`, only when the workflow file names `extensions.start.checks` or `extensions.close.checks`), the lanes' ledgers and recalled facts. For the full object add `--json`.
2. Read the conductor prompt it names, once. Skip the read if you already did this session. Follow its rules and the printed mode for the rest of the session (the mode skill `mode-<name>`, if the repo has one).
3. **Checks.** For each skill `start checks:` lists (`extensions.start.checks`): run its `## Start` section, or the whole skill when it has none, then record the outcome with `agentry lane session start --check <skill>=pass|fail --note "<one line>"`. A skill the line says has no `SKILL.md` is run by no one: say so and point to `/agentry:init`. A fail goes in the five lines below, and the recommendation becomes fixing it.
4. Tell the owner, in five lines at most: a held lane first (what it waits for and the evidence to open), an idle one, where the Now sprint stands, what is in flight, what waits on them, the drift worth acting on (each row already names its command), and the pending drafts or open questions. Use the printed words; invent nothing.
5. End with one recommendation: the single next step, usually the owner's answer to a held lane (resumed with their own words as `--note`, never on their behalf), the command a drift row names, `/agentry:exec <id>` for the next task whose deps are done, a failed start check to fix first, or `/agentry:close` when only drafts are left.

Use a recalled fact only where it applies to the work in flight, and cite its id. Never edit the board, never commit, never start work before the owner picks the next step.
