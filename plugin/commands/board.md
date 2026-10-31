---
description: Show where this repo's work stands and what's wrong with its board — derived status, then every rule finding. Read-only unless --fix.
argument-hint: "[status|check] [--why <id>] [--fix] [--json]"
---

Show this repo's board. Load the `process` skill; `board` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (exit 0 OK, 1 findings, 2 usage or spec error).

Pick the calls from `$ARGUMENTS`:
- nothing → `board status`, then `board check`;
- `status` or `check` → that one only;
- `--fix` → `board fix`: show what it wrote and what it left for the owner (judgment items are reported, never written). If this plugin's `board.mjs` has no `fix` yet (exit 2, unknown subcommand), say fix isn't available in this version and run `check` instead.

`--json` and `--why <id>` pass through unchanged to every call.

Show the output as printed: no rewording, no rebuilt tables, no findings dropped. Exit 1 is the normal "findings" result, not a failure. Exit 2 → show the message; when the process file is missing, point to `/agentry:init`.

Add at most one line after the output: the next step, if there is an obvious one (`/agentry:board --fix` for mechanical findings, `/agentry:init` for spec drift).

Read-only except `--fix`. Never hand-edit the board, never commit.
