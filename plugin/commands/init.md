---
description: Set Agentry up for this repo — scaffold a board in a new repo, learn the board it already has into .agentry/process.json (the lanes go in .agentry/workflow.json), or show and repair one already set up; then learn the gate and wire the lanes (conductor prompt, AGENTS.md trigger block, default agent, push policy). Asks only what it can't infer; never commits.
argument-hint: "[--relearn <kind>] — re-learn one kind of an existing setup"
---

Set up this repo's process. Load the `process` skill and follow its `references/learn.md`; the file format is in `references/format.md`. `agentry board` (exit 0 OK, 1 findings, 2 usage or spec error).

Shell calls use `agentry`, the plugin's `bin/` command; where it is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (or `lane.mjs`) with the same arguments.

Pick the state, then follow its section of `learn.md`:

1. **Set up** — `.agentry/process.json` exists. Run `agentry board explain`; show kinds × location × count, the rules on and their findings, and its `lanes` block (the workflow file, gate, conductor, trigger block, default agent, push policy, merge checks, the `.agentry/` commit policy per subfolder, the file's `version`: each ✓ or ✗ with the command that sets it), then any drift (a heading or column gone, unknown status words, an older `version`). A ✗ lane is a step to offer, not an error. Offer repairs one at a time; change nothing unless asked. `$ARGUMENTS` = `--relearn <kind>` → re-learn that kind only.
2. **Existing process** — `agentry board scan` finds board-like tables, id-led contract blocks or frontmatter items. Learn: draft the board from `scan` as `.agentry/run/process/process.json` (and any workflow key as `.agentry/run/process/workflow.json`), run `agentry board explain --process .agentry/run/process/process.json`, fix the draft, repeat until every kind finds items and every column maps. Rules: turn on each one that already holds on the data or that the repo's own process doc states; ask about one that is stated but fails, showing its findings; leave the rest off. Show the summary, then write the board keys to `.agentry/process.json` (and any workflow key to `.agentry/workflow.json`).
3. **New repo** — nothing found. Offer the templates (milestone, sprint, task, question, decision; epic optional), ask where (default `docs/work/`), copy them without overwriting anything, write `.agentry/process.json` from `templates/process.json` and `.agentry/workflow.json` from `templates/workflow.json`, run `agentry board check` (must be OK).

Then ask, once each and only what can't be inferred: is `.agentry/` committed, `process.json` and `workflow.json` alike (infer from `.gitignore` and `git ls-files .agentry` first)? Session-start status on? Map the code with `/agentry:onboard` (only if `.agentry/context.md` is missing)?

Then wire the lanes, in order, following `learn.md` § Wiring the lanes. A step already set up is shown, not asked again; every step writes to `.agentry/workflow.json`, each change through the draft (`.agentry/run/process/workflow.json`) and `agentry board explain --process .agentry/run/process/process.json`:

1. **Gate.** Learn it from the repo's workflow doc, gate scripts, CI config and `package.json` scripts; show where each part came from; confirm `gate.tiers` (the repo's gate as the last tier; a cheaper tier before it only with a stated scope, as its `when.only`) and `gate.after`. Never write `gate.command` or `gate.quick`: rewrite an old one as tiers.
2. **Conductor prompt.** Offer the repo's own or the template `templates/CONDUCTOR.md` → `conductor.prompt` and `conductor.rules`.
3. **Trigger block.** Ask once whether the block should stay out of the repo (recommend `--target local`, which puts it in `CLAUDE.local.md`, when `CLAUDE.md` is gitignored or the owner says the repo is public). Show `agentry board instructions` (or `agentry board instructions --target local`): the block for `AGENTS.md` or `CLAUDE.local.md`, and the `@AGENTS.md` import for an existing `CLAUDE.md` (or `@../AGENTS.md` for `.claude/CLAUDE.md` when that is where the instructions live; none for `CLAUDE.local.md`); on OK, `--apply`. Then run `agentry board instructions --lint` and offer each finding's replacement one at a time; edit a line only on the owner's OK.
4. **Default agent.** `agentry board default-agent`; on OK `--apply`, then `--verify`; `--verify live` only with the owner's OK (one small request). Say that teammates without Agentry fall back to plain Claude Code.
5. **Push policy.** Ask `merge.push` once (`ask` default, `auto`, `never`) unless it is set; write it to `.agentry/config.json`.
6. **Merge skill.** If the repo has its own merge skill, offer to name it in `extensions.merge.checks` and show its shrunk text (only the repo's own checks); edit the skill only on the owner's OK.
7. **Guard allowlist.** Only when the owner keeps files on main by hand while lanes run (a status file, a drafts folder), offer them as `guard.allow`; never a folder a task contract could own.
8. **Disposable files.** Propose `cleanup.disposable` globs from the `.gitignore` lines that are build output or caches (never `.env*`, local config, logs, screenshots; a folder glob also discards an ignored `.env` inside it, so propose a folder only when nothing local lives there); write only the ones the owner confirms.
9. **Permission rule.** If the owner wants fewer prompts, suggest `Bash(agentry:*)` for their settings, never a rule bound to a path; suggest it only, never write settings.
10. **Lifecycle writes.** The one question about harness writes. Only when the workflow file has no `lifecycle` (the merge's board row and the lifecycle's skips print `lifecycle off`): offer once to write the task's status, the verifier's verdict and the landed commit onto the board as work moves, saying what each key writes; draft the block from the task kind's own words and fields (`format.md` § lifecycle and drafts), and write it on the owner's OK. A no is final; a `lifecycle` already set is shown, not asked.
11. **Decision drafts.** Only when the board has a decision kind and the workflow file no `drafts.decision`: write it from the kind's `decision`, `why` and `rejected` fields (`learn.md` step 12) and say so; one already set is shown, not rewritten.

Never guess a mapping `explain` hasn't confirmed. Never commit or push; the board files, instruction files and repo skills stay the user's. End with the paths written and the last `agentry board check` result.

See also: `/agentry:new <kind>` adds items, `/agentry:board` shows status and findings, `/agentry:config` edits toggles.
