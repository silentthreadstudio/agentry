---
description: Add one item of any kind this repo's process knows — task, sprint, question, decision, or whatever init learned — to every place that kind lives. Asks only that kind's fields; never commits.
argument-hint: "<kind> [title or text]"
---

Add one item. `$ARGUMENTS`: the first word is the kind, the rest is its title or text. Load the `process` skill; `board` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"`.

1. **Kind.** No `.agentry/process.json` → say so, point to `/agentry:init`, stop. Read the kinds with `board explain --json`; a missing or unknown kind → list the learned kinds and ask. A kind with no `create` → say no create rule was learned for it and offer `/agentry:init --relearn <kind>`.
2. **Decision drafts.** For `decision`, follow the skill's `references/drafts.md` if it exists; until then say there are no drafts yet and go on.
3. **Before.** Run `board check --json` and keep its findings for the delta.
4. **Ask only the kind's `create.ask` fields**, minus what `$ARGUMENTS` already gave, in one `AskUserQuestion`: a ref or list field offers the existing ids of its kind (id, name, status) as options; a field with a fixed set of values offers those. The id: `board next-id <kind>` when `create.id` is a pattern (show it, let the user change it), asked when it is `ask`. A block with `under: "ask"` → ask which heading, from the file's headings, and pass it as its text (`Sprint A1`). Leading `#` marks, when given, must match the heading's level: `## Sprint A1` finds only a level-2 heading.
5. **Show exactly what will be written**, every `create` location: file › heading, position (end, or after which row) and the filled row or block text. Point out anything that looks like drift (a heading that names the parent differently from the board), but don't fix it.
6. **Write** with `board add <kind> --json '<fields>'`: the JSON holds `id`, every asked field, and a top-level `under` for an asked heading; one single-quoted argument, `'` written as `'\''`. Exit 2 → nothing was written: show the reason and stop. Relay every location it reports as skipped.
7. **After.** Run `board check --json` and report the delta: "no new problems", or each new finding. Close with where the item now stands (status, parent, what it waits on).

Never edit the board files by hand, never commit.
