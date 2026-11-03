# Session — start and close

Reference for the `conducting` skill, `/agentry:start` and `/agentry:close`. A session opens and ends with the
same two commands, so the repo's state is never kept in anyone's head: STATUS is derived from the board, and the
only hand-written file is a short judgment note.

## `agentry lane session start [--json]`

Reads only (without `--check`, below). Without `--json` it prints at most 40 lines of 80 columns; with it, one object:

| Field | Meaning |
| :--- | :--- |
| `prompt` | Absolute path of the conductor prompt (`conductor.prompt` in the workflow file), or null. Read it once per session. |
| `mode` | The `mode` string in `.agentry/config.json`, or null. Read as written; the mode's rules belong to the mode skill, not to this command. |
| `configError` | Only when the config reader refuses a config file (the text then shows `mode unreadable`): the error naming the file and key. `agentry lane exec` refuses the same file, so fix it first. |
| `held` | `[{ id, for, when, steps, since, evidence, resume }]` for every held lane, the owner's first, then the parked ones (`for: "later"`): `steps` is `step 1 of 2` (null with no steps), `evidence` is from the root, `resume` the step that answers it. |
| `idle` | `[{ id, minutes, lastChange, file, park }]` for every lane in `building` or `fixing` with no change in its worktree for 20 minutes (the newest of the round's dispatch, the branch's last commit and the mtime of every file git does not ignore); `park` is the `hold --for later` step. |
| `status` | The `agentry board status` view: `now`, `inFlight`, `onYou`, `blocked`, `ahead`, `nudges` (drift, each with the command to run), `drafts` (pending count), `recent`, `note`. |
| `recall` | Up to `memory.primeLimit` facts of this repo, the user's and the cross-project ones, ranked against the Now sprint and the work in flight. Empty when `memory.prime` is `off`. |
| `questions` | Open items of the owner-question kinds (the `onYou` rows that are not work items). |
| `ledgers` | `{ id, state, next }` of every lane ledger not closed, the held ones first. |
| `checks` | Only when the workflow file names `extensions.start.checks` or `extensions.close.checks`: `{ start: View, close: View }` (see Session checks). Without it the text and the object are as before. |

The text puts the lanes that wait on the owner right after the `conductor prompt:` line, before `now:`:

```text
held: T1 for the owner, after step 1 of 2, since 09:05
  evidence: .agentry/run/process/runs/T1/r1-build.report.md
  → agentry lane exec resume T1 --note "<the OK>"
parked: T4 since 10:12
idle: T6 2h13m: last change 11:44 (src/a.ts) → check the builder
  → agentry lane exec hold T6 --for later to park it
```

With start or close checks named, these lines come right after the `conductor prompt:` line, before the held
ones:

```text
start checks: repo-session, repo-ui (run each, then record it)
  → agentry lane session start --check <skill>=pass|fail --note "<line>"
start checks: repo-ui has no .claude/skills/repo-ui/SKILL.md
  → /agentry:init
last close: 1/2 passed (2026-11-02T18:40Z)
last close: repo-ui failed · the screenshot gate was red
```

`start checks:` lists the checks not yet recorded in this start window; a named skill with no `SKILL.md` adds
its own line, with the `→ /agentry:init` pointer under it. `last close:` shows how the close window stands (the last session's close, until a start check
is recorded): passed over named, the time of the newest entry (UTC, to the minute), then each failure with its
note on one line (at most three, then `last close: +N more failed`); a line is cut to 100 columns.

At most three held or parked lanes, then `held: +N more → agentry lane session start --json`; the idle lines
follow them. Held lanes are left out of `lanes:`.

The recommendation is yours, not the script's: the single next step. A held lane comes first: show the owner
its evidence and ask for the answer (it goes in `--note` as the owner said it; never resume on their behalf).
An idle lane next: check on its builder. Then the nudges (a drift row already names its command), then the
next ready task, then `/agentry:close` when only drafts remain.

## `agentry lane session close`

Reads only; prints one JSON object.

| Field | Meaning |
| :--- | :--- |
| `drafts` | Pending decision and rule drafts (`process` skill, `references/drafts.md`). |
| `fixPlan` | `agentry board fix --json` (no `--apply`): what `agentry board fix --apply` would write (`applied: false`), and what it leaves for the owner. |
| `ledgers` | `{ id, state, next }` of every ledger. |
| `cleanable` | Worktrees of tasks whose ledger says `merged` or `closed`: what `agentry lane sweep --apply` removes. |
| `strays` | Processes started under `<root>/.agentry/run/` (by executable, script or working directory): what `agentry lane sweep --apply` stops. |
| `leftAlone` | Would-be strays that are interactive shells (a controlling terminal, a login shell, `-i`). Never signalled. |
| `unknown` | Worktrees in `.agentry/run/worktrees/` no ledger knows. Reported, never removed. |
| `warnings`, `diskFree` | Free bytes, and a warning when under 10 GB. |
| `episodesPending` | Ids of ledgers with an episode nobody wrote: `agentry lane exec close <id>` prints it. |
| `checks` | As on start: `{ start: View, close: View }`; absent when no check is named. The handoff names `close.failed` and `close.pending`. |

The order of the ending is fixed: drafts, `agentry board fix`, sweep, episodes, checks, note, handoff. A draft is applied only on
the owner's OK. `agentry board fix --apply` writes only the mechanical pieces a board lacks.

## Session checks

A repo's own session skill is named in `extensions.start.checks` and/or `extensions.close.checks` (the same skill
may be in both; `/agentry:init` offers it). `/agentry:start` and `/agentry:close` run each (its `## Start` or
`## Close` / `## End` section, or the whole skill when it has none) and record the outcome:

`agentry lane session <start|close> --check <skill>=pass|fail [--note <t>] [--json]`

The form is exactly one `=` between a skill and `pass` or `fail` in lower case. A skill the phase does not name,
or one with no `.claude/skills/<skill>/SKILL.md`, is refused (exit 2); `--note` without `--check` is a usage
error. It appends one entry and prints `✓ <phase> check <skill>: pass` (or `✗ … fail · <note>`), then
`<phase> checks: <k>/<n> recorded · pending: <a, b> · failed: <c>` (empty parts left out). Exit 0 for either
result. `--json`: `{ phase, skill, result, note?, at, recorded, total, pending, failed }`.

The record is `<main root>/.agentry/run/process/session-checks.jsonl` (a call from a lane worktree writes the main
checkout's file): one line per entry, append-only, never committed:
`{ "phase", "skill", "result": "pass" | "fail", "note"?, "at" }`. A killed append is not repaired: the next
entry starts on a new line, and a line that is not an entry is skipped.

The record never claims to know a session; it reads phases. A phase's current entries are those after the
newest entry of the other phase (all of them when there is none), and per skill the newest current entry counts.
"Newest" is the later line in the file, never a sort by `at`. So at `/agentry:start`, before any start check is
recorded, the close window is the last session's close.

`View` (one per phase in `checks`) is `{ named, recorded: [{ skill, result, note?, at }], pending, failed, missing }`:
`named` is the phase's skills, `recorded` the newest current entry of each recorded one, `pending` the named
ones with none, `failed` the recorded fails and `missing` the named skills with no `SKILL.md`. A failed or
pending check stops nothing: close names it in the handoff and start in the five lines.

## `agentry lane sweep [--apply [--discard-ignored]] [--json]`

Without `--apply` it only reports. With it:

- removes the worktree of a task whose ledger says `merged` or `closed` (through `worktree.remove`: a
  worktree with uncommitted changes is kept and named, and the branch is deleted only when everything on it
  is on main). One holding ignored files (`.env`, build output) is kept and named unless `--discard-ignored`;
- stops each stray: a process whose executable, script (for an interpreter such as `node` or `sh`) or
  working directory is under `<root>/.agentry/run/`, that no lane still building owns. A command line that
  only mentions such a path (`tail -f …/gate.log`) is not one. The stray and its whole descendant tree get
  SIGTERM, then SIGKILL after two seconds, and sweep confirms they are gone. Any pid still running is listed
  and the exit is 1;
- never signals an interactive shell: a process on a controlling terminal, a login shell (`-zsh`), or a
  shell run with `-i` (only an option before the script or `-c` counts). A terminal above a stray never
  spares it, and a `-i` shell with no terminal that a stray started is part of the stray. The owner's
  terminal can sit in a merged worktree; it is listed as `left alone: interactive shell`, and the worktree
  it sits in is kept ("in use by a shell") until the owner leaves that directory.
- signals only what it can prove is the stray's: the stray, its own descendant tree, and its process group
  only when the stray leads it (pid equals pgid). A stray that sits in someone else's group (a parent that
  did not detach it) takes none of that group: the leader and its other children are left alone. A
  double-forked child of such a stray, left in the group it does not lead, cannot be proven ours and is
  left running; stop it by hand. A process a lane still building owns is never signalled, even inside a
  stray's tree, and neither is the sweep's own ancestor chain. Everything that would be signalled is listed
  under its stray in the preview (`with process …`) and, after `--apply`, in `signalled`.

A worktree no ledger knows is listed as unknown and left alone, as is any worktree of a task still in flight.
Working-directory strays need `lsof`; without it sweep warns and judges by executable and script only.
Ask the owner before `--apply`; it exits 1 when it kept a worktree or left a process running.

## The note

`close` leaves a note of at most 10 lines at the board's note file (`status.note`, default `.agentry/NOTE.md`),
which `agentry board status` and `start` show. It holds judgment, not state: where the owner's thinking was leaning, the
risk to watch, what to do first next time. Anything the board can derive does not belong in it.
