# Session — start and close

Reference for the `conducting` skill, `/agentry:start` and `/agentry:close`. A session opens and ends with the
same two commands, so the repo's state is never kept in anyone's head: STATUS is derived from the board, and the
only hand-written file is a short judgment note. `lane` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.mjs"`.

## `lane session start [--json]`

Reads only. Without `--json` it prints at most 40 lines of 80 columns; with it, one object:

| Field | Meaning |
| :--- | :--- |
| `prompt` | Absolute path of the conductor prompt (`conductor.prompt` in the process file), or null. Read it once per session. |
| `mode` | The `mode` string in `.agentry/config.json`, or null. Read as written; the mode's rules belong to the mode skill, not to this command. |
| `status` | The `board status` view: `now`, `inFlight`, `onYou`, `blocked`, `ahead`, `nudges` (drift, each with the command to run), `drafts` (pending count), `recent`, `note`. |
| `recall` | Up to `memory.primeLimit` facts of this repo, the user's and the cross-project ones, ranked against the Now sprint and the work in flight. Empty when `memory.prime` is `off`. |
| `questions` | Open items of the owner-question kinds (the `onYou` rows that are not work items). |
| `ledgers` | `{ id, state, next }` of every lane ledger not closed. |

The recommendation is yours, not the script's: the single next step, from the nudges first (a drift row already
names its command), then the next ready task, then `/agentry:close` when only drafts remain.

## `lane session close`

Reads only; prints one JSON object.

| Field | Meaning |
| :--- | :--- |
| `drafts` | Pending decision and rule drafts (`process` skill, `references/drafts.md`). |
| `fixPlan` | `board fix --dry-run --json`: what `board fix` would write, and what it leaves for the owner. |
| `ledgers` | `{ id, state, next }` of every ledger. |
| `cleanable` | Worktrees of tasks whose ledger says `merged`: what `lane sweep --apply` removes. |
| `strays` | Processes whose command line is under `<root>/.agentry/run/`: what `lane sweep --apply` stops. |
| `unknown` | Worktrees in `.agentry/run/worktrees/` no ledger knows. Reported, never removed. |
| `warnings`, `diskFree` | Free bytes, and a warning when under 10 GB. |
| `episodesPending` | Ids of ledgers with an episode nobody wrote: `lane exec close <id>` prints it. |

The order of the ending is fixed: drafts, `board fix`, sweep, episodes, note, handoff. A draft is applied only on
the owner's OK. `board fix` writes only the mechanical pieces a board lacks.

## `lane sweep [--apply] [--json]`

Without `--apply` it only reports. With it:

- removes the worktree of a task whose ledger says `merged` (through `worktree.remove`: a worktree with
  uncommitted changes is kept and named, and the branch is deleted only when everything on it is on main);
- sends SIGTERM to a process whose command line contains `<root>/.agentry/run/`, and to nothing else.

A worktree no ledger knows is listed as unknown and left alone, as is any worktree of a task still in flight.
Ask the owner before `--apply`; it exits 1 when it kept a worktree it was asked to remove.

## The note

`close` leaves a note of at most 10 lines at the board's note file (`status.note`, default `.agentry/NOTE.md`),
which `board status` and `start` show. It holds judgment, not state: where the owner's thinking was leaning, the
risk to watch, what to do first next time. Anything the board can derive does not belong in it.
