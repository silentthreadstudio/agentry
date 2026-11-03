# Merge — landing a task on main

Reference for the `conducting` skill and `/agentry:merge`. One procedure lands a task: `agentry lane merge` does
every git, gate and board step and prints what it did. A repo's own merge skill keeps only what is specific
to that repo, and merge calls it as a check (`extensions.merge.checks`). `lane` means
`agentry lane`.

A task is `done` when its commits are on main (A23). The merge is what makes it `done`. A verifier's PASS
leaves the task in verify.

## The calls

| Call | Does |
| :--- | :--- |
| `agentry lane merge <id> [--branch <b>] --preflight` | Reads what landing needs and changes nothing on main. With `--branch`, adopts work built outside exec. |
| `agentry lane merge <id> --check <skill>=pass\|fail [--note <t>]` | Records one repo check's outcome on the branch's current tip. |
| `agentry lane merge <id> [--branch <b>] --message <m> [--summary <t>] [--drop-carry]` | The land: pick → gate or skip → record → board commit. `--drop-carry` lands without exec's writes the ledger holds, on the owner's call only. |
| `agentry lane merge <id> --push [--approved]` | Pushes main per `merge.push`. |
| `agentry lane merge <id> --cleanup [--discard-ignored]` | Removes the task's worktree and branch. |

Exit 0 = the step is done and `next` names the following one. Exit 1 = a red step stopped it, and its row
says why. Exit 2 = usage or a refusal. A refusal before the land starts changes nothing; a land refused
at `main` may first have done what the rows above it say (a killed run's own writes taken back, exec's
writes put back on main). Run every call in the foreground from the main checkout and read the exit code.
A pipe would report the last command's exit, not merge's.

Each row carries a mark: `✓` holds, `!` holds with a warning to show the owner (a branch not cut from
main's tip: the picks may conflict), `✗` red, `·` skipped, `…` waiting. `--json` with any mode prints the
same rows and `next` as one object.

Before the first `--preflight` in a repo, main must be clean and the setup committed: the process and workflow
files, the conductor prompt, `AGENTS.md` and any board rows added by hand or by `/agentry:new`. The `main` row
refuses anything else uncommitted (see below), so a fresh setup left uncommitted stops the first land.

Each call is idempotent from the task's ledger (`.agentry/run/process/ledger/<id>.json`). Re-run the land
after fixing what stopped it, and it resumes. Picks already on main are not picked again, and a gate
already green on main's HEAD does not run again. A land that already finished prints "already merged".
A land that was killed resumes the same way: see [A killed land](#a-killed-land).

## The land, row by row

| Row | Checks | Red or refused when |
| :--- | :--- | :--- |
| `ledger` | The exec ledger (state `verified`), or a new one adopted from `--branch` (origin `adopted`, counted as a bypassed dispatch). A `stopped` exec lane lands only on the owner's call, with `--branch <its branch>`, and is adopted from then on. | No ledger and no `--branch`; the lane is still building, verifying or fixing; it is stopped and its branch isn't named. |
| `board` | The id is on the board once, in the lifecycle's kind. | It isn't. With no `lifecycle` the row is skipped and nothing is written. |
| `checks` | Each `extensions.merge.checks` skill exists in `.claude/skills/<name>/SKILL.md` and has an outcome recorded on the branch's current tip. | A skill is missing (exit 2), a check is unrecorded or was recorded on an older tip (exit 2), or a check failed (exit 1). |
| `recover` | Only after a killed land: what it left, dealt with before anything else. See [A killed land](#a-killed-land). | The gate it left will not die; git is in the middle of a cherry-pick or revert that is not provably this land's; a board file it wrote changed since, or the commit after its picks is not provably its board commit. |
| `main` | The main checkout is on the main branch and `git status` is empty, untracked files included. Two exceptions. A new, untracked memory record (`.agentry/memory/facts/` or `episodes/<slug>-<ULID>.md`, Agentry's own write) doesn't count, and the land leaves it as it is. Uncommitted edits that are exactly lifecycle cells (status, verdict, commit) of tasks with an open lane, read at the board's model level against HEAD, are carried. The landing task's own cells count: they go into the board commit as they are, so a verdict edited by hand lands with it. | Any other change, a stray edit next to exec's write included: each is named, and the stop says it is not in `guard.allow`. Commit it or undo it first. |
| `allow` | The owner's uncommitted edits of files `guard.allow` names (not board files), and new untracked files under its globs, are no stop: they are recorded in the ledger first (`merge.allow`: the files, the patch, its sha256; a new file as a new-file patch), set aside so the picks, the gate and the board commit see a clean tree (a new file is deleted, then made again), and put back, uncommitted, after the board commit, at any stop, or first thing on the rerun of a killed land. Any other change still refuses, in the `main` row. | An edit that no longer applies on the landed files (the picks changed the same lines) is saved to `merge-allow-<n>.patch` in the run dir and named in a `!` row: nothing is lost, `git apply` it by hand. A picked commit that adds the path of an untracked allowed file refuses the land before any pick: `<path>: untracked on main and added by <sha> → move it aside or commit it, then rerun`. |
| `writes` | A file changed on main only by `agentry board add` / `board set --apply` is no stop either. Those writes are recorded (`.agentry/run/process/board-writes.jsonl`), and a file counts only when its content is reached from HEAD's through recorded writes, as the lane's guard reads them; a hand edit of the file, alone or after a write, still refuses. The land records the file in the ledger first (`merge.writes`: the files, the patch, its sha256, the changed cells), sets it aside, and puts it back after the board commit, uncommitted, for the owner: it is never in the board commit. | A picked commit that changes the same file merges by cell when the write only changed cells (`board set`) and the commit leaves those cells and their rows alone; the cells are set again by id on the landed file. A commit that changes or removes a written cell, a row added by `board add`, or prose cannot merge that way: the land refuses before any pick, naming the file, the recorded write and the commit. Rows added by `board add` also go back when the land's own board commit rewrote a neighbouring row (the new task beside the landing one): each is put under the row it was written below, found by its id. An edit that still does not apply is saved to `merge-writes-<n>.patch` and named in a `!` row. Patches are kept as bytes, so a file that is not UTF-8 comes back unchanged. |
| `carry` | Exec's uncommitted board writes are recorded in the ledger first (`merge.carry`: each cell with its text before and after, and the patch, each with its sha256), then set aside, so the picks, the gate and a rollback see a clean tree and a kill cannot lose them. They go back cell by cell, each found by its task id, so another lane writing its own row meanwhile (an exec start while the gate runs) doesn't get in the way. They go back on top of the picks before `record` and land in the board commit. | A carried cell reads something else by then (the picks or a hand edit changed that very cell): it's named, they stay in the ledger and every rerun stops, until the owner passes `--drop-carry`. On any other stop, main gets them back, uncommitted. |
| `land` | `git cherry-pick <shas…>` of every branch commit not already on main by patch. | A merge commit on the branch (rebase first). A pick stops: the sequence is aborted (`cherry-pick --abort`) and main is asserted back at `preHead`, clean. Then the builder rebases its branch. |
| `gate` | Skipped only when the ledger holds a green full worktree gate, clean before and after, main's tree after the picks equals the branch tip's tree, and every file changed since that gate matches `gate.after`. Otherwise it runs the tier `pickTier` picks (`quick` only when every landed file matches `gate.quick.only`). The row names the tier and why, or the gate it trusted and the `after` glob each later file matched. Queued behind the lanes' gates, it says so in its log (`waiting for gate slot N (held by <who> since HH:MM)`, then `slot acquired`). A red that fails only in `gate.flaky` tests (names read from the log or `gate.flakyLogs`) is re-run alone once; both runs are in the ledger. | The gate exits non-zero or leaves files, or fails again alone on the flaky re-run (the stop names that re-run, not the builder). Main is reset to `preHead`, but only after asserting that main's first-parent chain since `preHead` is exactly the picked commits and the tree is clean. Otherwise it stops and says so. |
| `record` | Exec's carried cells are set again, then the lifecycle's `merged` event: status, the commit cell (`<first>…<last>`) and the handoff line. Both are worked out first in a scratch copy of the board, and the sha256 of each file's new text goes to the ledger (`merge.record`) before main is touched. `agentry board check` is compared with the board as committed before either write. | A rule fails for an item it didn't fail for before, whichever write brought it. The written files are restored, the picks stay on main, and exec's writes go back on main uncommitted. |
| `commit` | One commit of exactly the files `record` wrote and the carried board files, with the repo's own hooks. | Main holds any other change; a hook refuses (the files are restored); main isn't clean after the commit. |

The board commit message follows the repo's commit conventions and carries the author only. A message with
AI attribution (a co-author trailer, a session link, a "generated with" line) is refused before anything
runs. `--summary` is the handoff text. Without it, the first landed commit's subject is used.

A long gate (more than the host's foreground limit) is the reason to run the land in the host's background
mode. Then wait for its single exit notice. The ledger records the outcome either way.

## A killed land

A land can be killed at any point, by a host's time limit most often. It writes what it is about to do to
the ledger before it does it, so the answer is always the same: run the land again. Don't clean up by hand
first. The preflight says what the land will clear. The rerun acts only on what it can prove is its own;
anything else stops it, left as it is, and `next` gives the commands that clear it.

| Killed | The rerun |
| :--- | :--- |
| After the guard.allow edits were set aside, before they went back | Puts them back first (an edit already back is left), then carries on. |
| Before the carry was set aside | Finds exec's writes still on the tree and lets go of the ledger's copy, then takes them again. |
| During the picks, git mid-sequence | Aborts the cherry-pick only when it is provably its own: the ledger says it was picking, `CHERRY_PICK_HEAD` is a planned commit, the sequencer lists only planned picks, no revert is in progress and no resolution was staged by hand. Then it takes off the picks left on main and picks them all again (two aborts when git kept a stale `CHERRY_PICK_HEAD`). Any other cherry-pick or revert is left alone and stops the land. |
| After the picks | Reads from main which picks it holds and does not pick twice. |
| During the gate | Stops the gate's process group, found by its pid file and nonce (a pid another process reused is left alone), and gates again. The killed gate's log stays. |
| After a red gate, in the rollback | Finishes the rollback, gives the lane its state back and exec's writes back to main, and reports the red gate. |
| After the board writes, before the commit | Takes back only the files `merge.record` names whose index and working copy each hold HEAD's text or the text it wrote, then writes them again from its green gate. Every other board file is left alone. A file it wrote that changed since (a note, another lane's cell, a formatting hook) stops the land, named with the copy that changed (staged, working copy or both), with nothing written; `next` shows both diffs before the restore that clears it. A commit after the picks that only adds memory records (the owner committing an episode) isn't in the way: the land commits the board on top of it. |
| After the board commit | Takes the commit right after its picks as its own only when it changes exactly the files `merge.record` names, each to the text it wrote; then records the land as merged, naming any later commit as not its own. Any other commit there stops the land; for a board commit a hook grew, `next` gives the `git reset --keep` that lets the land commit again. |

`--drop-carry` is the one owner's call here. It keeps the patch in the task's run dir
(`merge-carry-dropped-<n>.patch`), takes the edits off main's tree if they are still there, and lands
without them.

## Repo checks

A repo check is judgment the repo owns, such as "the UI was seen running and the owner OK'd it", or a second
handoff file. Run the named skill's checks yourself, then record the outcome with a one-line note. A check
counts only for the branch tip it was recorded on: new commits on the branch mean recording it again. Scripted
checks belong in the repo's gate command, which merge already runs.

## Push

`merge.push` in `.agentry/config.json` (project, then global; default `ask`):

- `auto`: `agentry lane merge <id> --push` after the land.
- `ask`: ask the owner in the session. Only on their yes, `agentry lane merge <id> --push --approved`.
- `never`: merge refuses to push. The owner pushes.

Push goes to main's upstream and runs the repo's pre-push hooks. With no upstream it refuses.

## Cleanup

The worktree is found by its branch, whatever its directory is called, and removed with `-f -f`, so a locked
one comes down too. The branch is deleted only when every commit on it is on main. Ignored files that the
workflow file's `cleanup.disposable` globs match (build output, import caches) are discarded without asking. So are ignored files under `**/node_modules/**` and `**/dist/**` (`DEFAULT_DISPOSABLE`, always on, tracked files never). `agentry lane sweep` uses the same set: a merged or closed worktree whose only ignored files are disposable is swept, and its line says `discarded <n> disposable path(s)` (<n> counts the entries git lists: an ignored folder is one); any other ignored or untracked file keeps it.
Cleanup refuses while the worktree holds any other ignored file (screenshots, a local `.env`), because
removal deletes it. List them, copy what the owner wants to keep, and re-run with `--discard-ignored` only on
their yes.

## When it stops

| Stop | Do |
| :--- | :--- |
| Cherry-pick conflict | Resume the builder (or a fresh one in the same worktree) to rebase `agentry/<id>` onto main, then re-run the gate in the worktree (`agentry lane exec gate <id>`) and land again. |
| Red gate, rolled back | Read the log the row names. Fix on the branch through the exec lane, then land again. A red only in `gate.flaky` tests was already re-run alone once: if the stop says it failed again alone, it is not load. |
| Red gate, rollback refused | Main holds more than the picks, or files changed while the gate ran. A lane's lifecycle write made meanwhile is not lost: run the same land again, and it sets the write aside, gates again and lands or rolls back. Anything else it names: show the owner. Don't reset by hand. |
| New board finding | Fix what the finding names, then land again. It resumes after the picks. |
| Main moved since the land | Someone committed between two runs. Show the owner the log since `preHead`. |
| Exec's writes no longer apply | A carried cell changed since it was set aside; the row names it and what it reads now. Show the owner that row, `git diff` and `merge.carry`. Only on their call, land again with `--drop-carry`. |
| Files still set aside | A stop that keeps the carry (a pick the abort did not undo, a recovery stop) leaves the owner's allowed files and board-script writes in the ledger and says so: `allow: <n> file(s) set aside (<paths>) → restored by <the land command>` (every argument is one shell word: quoted with `'…'` unless it is only `A-Za-z0-9_./:=@%+-` and does not start with `-`). Do what the stop's `next` says, then run that command: it puts them back first. |
| A set-aside record from an older version | A `merge.allow` / `merge.writes` record without `enc: "bytes"` was written when patches were kept as text. It is never applied: the land keeps its patch once in the run dir (`merge-allow-<n>.patch` / `merge-writes-<n>.patch`), refuses with exit 2 (`carry: recorded by an older version (text patch) → restore it by hand from <path>, then rerun with --drop-carry`) and leaves the record in the ledger. Restore the edit from the patch by hand, then land again with `--drop-carry`; that drops the record, patch kept. Only on the owner's call. |
| A lifecycle write and a board add in one file | `<file>: a lifecycle write by <lane> and a board add by <the recorded write> share this file → land <lane> first, or commit the added row`. Nothing is set aside. The same two writes in two different files land. |
| A cherry-pick or revert that is not this land's | Someone else's, another task's killed land, or one resolved by hand. Show the owner; that task's own land clears its pick. |
| A killed land's board write or commit it cannot prove | Show the owner the row and `next`: it names the file or commit and the exact commands that clear it. |
| A killed land | Run the land again. See [A killed land](#a-killed-land). |

Never finish a stopped step by hand: no hand cherry-pick, `reset`, board edit, commit or push. A hand step
leaves the ledger behind the repo, and the next call refuses or repeats work.
