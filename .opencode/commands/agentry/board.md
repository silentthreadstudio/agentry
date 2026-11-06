<!-- Generated from plugin/commands/board.md by scripts/build-opencode.mjs — edit the source, not this file. -->
---
description: Show where this repo's work stands and what's wrong with its board — derived status, drift nudges, then every rule finding. Read-only unless --apply.
---

Show this repo's board. Load the `process` skill; `agentry board` (exit 0 OK, 1 findings, 2 refused, usage or bad config; `agentry board <sub> --help` for any subcommand).

Shell calls use the plugin's `agentry` bin `command` when it is on PATH; otherwise run `node "plugin/bin/agentry" <board|lane|mem|draft|run|lock> …` with the same arguments.

Pick the calls from `$ARGUMENTS`:
- nothing → `agentry board status`, then `agentry board check`;
- `status` or `check` → that one only;
- `fix` → `agentry board fix`: it shows what it would write and what it leaves for the owner, and writes nothing. `fix --apply` → `agentry board fix --apply`: show what it wrote and what it left. It writes only the mechanical pieces a board lacks (a status, a commit, a handoff line `agentry board check` accepts), never rewrites a cell someone wrote, and marks a task done only when that is provable: a `/agentry/merge` record that matches its branch, whose commits are still on main and whose change is still where it landed (each line it added still there, each line it removed not back). A revert, a reset or a later rewrite of those lines makes it unsure, and so does a line typed back into a file that now differs otherwise. Anything unsure is listed and nothing is written for it. It exits 1 while something is left for the owner; each of those is listed with the command that deals with it. If this plugin's `board.mjs` has no `fix` (exit 2, unknown subcommand), say fix isn't available in this version and run `check` instead;
- `fix --accept <id>` → `agentry board fix --accept <id>`: a task merged by hand (no merge record). Show what it would write, ask the owner whether that task's work really landed on main, and only after they say yes run `agentry board fix --accept <id> --apply`. It still writes nothing unless the commits carrying that work on main are still in effect now. It needs a ledger: for a worktree no ledger knows, adopt it first with `/agentry/merge <id> --branch <branch>` (merge then reports nothing left to land), then accept;
- `draft …` → `agentry board draft <list|add|drop|apply>` as given. `add` needs its draft as `--fields '{"kind":"decision"|"rule","answer":"…"}'` (optional `question`, `unpicked`, `source`; `references/drafts.md`); without it, it stops at the usage error. `apply <n>` shows what it would write; `apply <n> --apply` writes a decision or a standing rule, so run it only after the owner says OK to that draft (`references/drafts.md`).

`--json` and `--why <id>` pass through unchanged to every call. `status --ready` lists each sprint's open tasks with whether the contract is found and the dependencies are done: what can be built next.

`agentry board status` adds a **Drift** block when work went around the commands: an agent worktree no ledger knows (`unlisted-worktree`), a task the board shows started with no ledger (`started-by-hand`), commits on main no merge covers (`merged-by-hand`), a verified task waiting for its merge (`verified-not-merged`), an episode nobody wrote (`episode-pending`), and a hand status file still listing a finished task (`stale-status`, when the process file sets `status.file` and `status.next`). A worktree matching `worktrees.keep` shows on a **Kept** row instead. Each row names the command to run; a **Drafts** row counts the owner's calls not yet written down.

Show the output as printed: no rewording, no rebuilt tables, no findings dropped. Exit 1 is the normal "findings" result, not a failure. Exit 2 → show the message; when the process file is missing, point to `/agentry/init`.

Add at most one line after the output: the next step, if there is an obvious one (`/agentry/board fix` for mechanical findings, the command a Drift row names, `/agentry/init` for spec drift).

Read-only except `fix --apply` and `draft apply <n> --apply`. Never hand-edit the board, never commit.
