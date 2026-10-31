---
description: Set Agentry up for this repo's process — scaffold a board in a new repo, learn the board it already has into .agentry/process.json, or show and repair one already set up. Asks only what it can't infer; never commits.
argument-hint: "[--relearn <kind>] — re-learn one kind of an existing setup"
---

Set up this repo's process. Load the `process` skill and follow its `references/learn.md`; the file format is in `references/format.md`. `board` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (exit 0 OK, 1 findings, 2 usage or spec error).

Pick the state, then follow its section of `learn.md`:

1. **Set up** — `.agentry/process.json` exists. Run `board explain`; show kinds × location × count, the rules on and their findings, the config (as `/agentry:config` shows it), the `.agentry/` commit policy and any drift (a heading or column gone, unknown status words, an older `version`). Offer repairs one at a time; change nothing unless asked. `$ARGUMENTS` = `--relearn <kind>` → re-learn that kind only.
2. **Existing process** — `board scan` finds board-like tables, id-led contract blocks or frontmatter items. Learn: draft the file from `scan` under `.agentry/run/process/`, run `board explain --process <draft>`, fix the draft, repeat until every kind finds items and every column maps. Rules: turn on each one that already holds on the data or that the repo's own process doc states; ask about one that is stated but fails, showing its findings; leave the rest off. Show the summary, then write `.agentry/process.json`.
3. **New repo** — nothing found. Offer the templates (milestone, sprint, task, question, decision; epic optional), ask where (default `docs/work/`), copy them without overwriting anything, write the process file from the template, run `board check` (must be OK).

Then ask, once each and only what can't be inferred: is `.agentry/` committed (infer from `.gitignore` and `git ls-files .agentry` first)? Session-start status on? Harness writes on? Map the code with `/agentry:onboard` (only if `.agentry/context.md` is missing)?

Never guess a mapping `explain` hasn't confirmed. Never commit or push; the board files stay the user's. End with the paths written and the last `board check` result.

See also: `/agentry:new <kind>` adds items, `/agentry:board` shows status and findings, `/agentry:config` edits toggles.
