---
description: Land one task on main — preflight, the repo's own checks, cherry-pick, the gate (or the recorded gate it may trust), the board's done row, SHA and handoff line in one commit, then push per policy and cleanup. Stops at the first red step.
argument-hint: <task id> [--branch <branch>]
---

Land task `$ARGUMENTS` on main. What each row means and every edge case: the `conducting` skill's `references/merge.md`.

Run each call from the main checkout, in the foreground, and read its exit code: 0 = done, `next` printed; 1 = a red step stopped it; 2 = usage or refusal. Never pipe it into `grep`/`tail` to decide. Show each step table as printed.

Before the first `--preflight`, main must be clean: `git status` empty, with the setup committed (`.agentry/process.json`, the conductor prompt, `AGENTS.md`, the board rows `/agentry:new` added). Otherwise the `main` row is red and names each file; ask the owner to commit or undo them (never commit for them).

1. `agentry lane merge <id> --preflight`. Add `--branch <b>` only for work built outside `/agentry:exec` (it adopts that branch).
2. For each repo check the table names (`extensions.merge.checks`): run that skill's checks, then `agentry lane merge <id> --check <skill>=pass|fail --note "<one line>"`.
3. `agentry lane merge <id> --message "<board commit message>" [--summary "<handoff text>"]`: the repo's commit conventions, no AI attribution. If the call dies (a host's time limit), run the same land again: it clears what it can prove it left and resumes; if it stops instead, follow `next`. Add `--drop-carry` only on the owner's call, when the table says exec's writes no longer apply.
4. Follow `next`. `ask` → ask the owner, and add `--approved` only on their yes. `never` → no push. Then `--cleanup` (it discards `cleanup.disposable` files on its own). If it refuses on other ignored files, show them and ask; `--discard-ignored` only on a yes.

On exit 1 or 2, stop and show why. Do what `next` says, or ask the owner. Never finish a step by hand: no hand cherry-pick, reset, board edit, commit or push.
