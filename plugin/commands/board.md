---
description: Show where this repo's work stands and what's wrong with its board — derived status, drift nudges, then every rule finding. Read-only unless --fix or a draft is applied.
argument-hint: "[status|check] [--why <id>] [--fix [--dry-run] [--accept <id>]] [draft list|add|drop <n>|apply <n>] [--json]"
---

Show this repo's board. Load the `process` skill; `board` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (exit 0 OK, 1 findings, 2 usage or spec error).

Pick the calls from `$ARGUMENTS`:
- nothing → `board status`, then `board check`;
- `status` or `check` → that one only;
- `--fix` → `board fix` (add `--dry-run` to see it first): show what it wrote and what it left for the owner. It writes only the mechanical pieces a board lacks (a status, a commit, a handoff line), never rewrites a cell someone wrote, and marks a task done only when that is provable: a `/agentry:merge` record whose commits are still on main and whose change is still there. Anything unsure is listed and nothing is written for it. It exits 1 while something is left for the owner; each of those is listed with the command that deals with it. If this plugin's `board.mjs` has no `fix` (exit 2, unknown subcommand), say fix isn't available in this version and run `check` instead;
- `--fix --accept <id>` → `board fix --accept <id>`: a task merged by hand (no merge record). Ask the owner first whether that task's work really landed on main, and run it only after they say yes. It still writes nothing unless the branch's change is on main now;
- `draft …` → `board draft <list|add|drop|apply>` as given. `add` needs its draft as `--json '{"kind":"decision"|"rule","answer":"…"}'` (optional `question`, `unpicked`, `source`; `references/drafts.md`); without it, it stops at the usage line. `apply` writes a decision or a standing rule, so run it only after the owner says OK to that draft (`references/drafts.md`).

`--json` and `--why <id>` pass through unchanged to every call.

`board status` adds a **Drift** block when work went around the commands: an agent worktree no ledger knows (`unlisted-worktree`), a task the board shows started with no ledger (`started-by-hand`), commits on main no merge covers (`merged-by-hand`), a verified task waiting for its merge (`verified-not-merged`), and an episode nobody wrote (`episode-pending`). Each row names the command to run; a **Drafts** row counts the owner's calls not yet written down.

Show the output as printed: no rewording, no rebuilt tables, no findings dropped. Exit 1 is the normal "findings" result, not a failure. Exit 2 → show the message; when the process file is missing, point to `/agentry:init`.

Add at most one line after the output: the next step, if there is an obvious one (`/agentry:board --fix` for mechanical findings, the command a Drift row names, `/agentry:init` for spec drift).

Read-only except `--fix` and `draft apply`. Never hand-edit the board, never commit.
