---
description: Close the session the same way every time — the owner's pending decision drafts, board fix, worktree and process cleanup (asks before applying), episodes for finished lanes, a short judgment note, and the handoff with the resume line.
---

Close the session. `lane` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.mjs"` and `board` the same with `board.mjs`. Run them from the main checkout, in the foreground. The details of every field: the `conducting` skill's `references/session.md`.

1. Run `lane session close`. It prints one JSON object and writes nothing: `drafts`, `fixPlan`, `ledgers`, `cleanable`, `strays`, `leftAlone`, `unknown`, `warnings`, `diskFree`, `episodesPending`.
2. **Drafts.** Re-read the session for owner calls that were never drafted and run `board draft add` for each (the `process` skill's `references/drafts.md`). Then show every pending draft (`board draft list`, and `board draft apply <n>` for what one would write) and ask the owner to OK, drop or correct it. Run `board draft apply <n> --apply` only on that draft's OK.
3. **Board.** If `fixPlan` lists fixes (it is `board fix` without `--apply`: what it would write), run `board fix --apply` and show what it wrote. Show what it leaves for the owner, each with its command.
4. **Sweep.** Show `cleanable`, `strays`, `leftAlone`, `unknown` and `warnings` (low disk, or no `lsof`, is a warning to say, not to fix). Ask the owner before `lane sweep --apply`, and say what it will remove and stop. Unknown worktrees are listed, never removed; a `leftAlone` process is an interactive shell (a terminal, a login shell) that sits in a merged worktree: sweep never signals it, so tell the owner to leave that directory. `--apply` exits 1 if a process or a worktree is still there; say which.
5. **Episodes.** For each id in `episodesPending`: `lane exec close <id>`, call `episode_write` with the episode it prints, then `lane exec close <id> --episode <the id it returns>`.
6. **Note.** Write the judgment note to the board's note file (`status.note` in the process file, default `.agentry/NOTE.md`): at most 10 lines, what a cold reader needs that the board does not say (decisions leaning, risks, what you would do next). It replaces the previous note. No status table: status is derived.
7. **Hand off** in a few lines: what landed, what is still open, drafts left, and the resume line `/agentry:start`.

Never edit board files by hand, never commit or push, never apply a draft or a sweep without the owner's OK.
