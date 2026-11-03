# Lanes: `exec` and `ask`

Reference for the `conducting` skill. A lane is an explicit command for work whose shape is already known, so it
skips routing. `/agentry:exec <task-id>` builds a contract that already exists; `/agentry:ask <question>` answers
a question. `/agentry:go` stays the full pipeline and never routes to a lane on its own.

## What a lane never does

- No right-sizing, no spec, plan or split step, no spec or plan gate. The planning already happened.
- No Flow MCP calls (`run_start`, `task_*`, `event_emit`, `artifact_write`, `review_*`, `backlog_*`).
- No files under `.agentry/work/` (`spec.md`, `plan.md`, `tasks/*.md`).
- No board edits by hand and no contract edits. The exec steps write the board through the process file's
  `lifecycle`; a repo without one gets no writes.
- No merge, no push: `/agentry:merge` lands the work.

## exec

The lane's state is a ledger, `.agentry/run/process/ledger/<id>.json` in the main checkout, stepped by
`lane exec <step> <id>` (`scripts/lane.mjs`). Each step checks that the ledger expects it, does the git and board
work, writes the ledger and prints one JSON object. The conductor runs the step `next` names and dispatches the
prompt the step printed. It never composes a brief, picks the next round or writes the board itself.

| Step | Does | Board (through `lifecycle`) |
| :--- | :--- | :--- |
| `start <id>` | finds the contract, refuses at `lanes.maxWriters`, cuts `agentry/<id>` in `.agentry/run/worktrees/<id>`, briefs the builder | `dispatched` |
| `report <id> [--agent a]` | reads the builder's report, runs the guards, briefs the next round | `built` when a verifier is next |
| `verdict <id> [--agent a]` | reads the verifier's report and its tip, briefs the next round | the verdict (`FAIL` also `failed`) |
| `gate <id>` | waits for the gate lock, runs the repo's `gate` in the worktree as argv, records `{commit, tree, exit, clean before and after, log}`; a red whose log fails only in `gate.flaky` tests is re-run alone once and both runs are recorded | none |
| `fix <id> --notes N1,N3` | after `PASS WITH NOTES` (gate or close next): a builder round (resume) on those notes of the verifier's report, then the usual `recheck` | none |
| `close <id> [--episode e]` | prints the `episode_write` payload; `--episode` stamps the id it returned | none (`done` comes at merge) |
| `show <id>` | the ledger and the pending dispatch, for a cold resume | none |
| `owns <id> [--set a,b] [--apply]` | the owned files every brief names, parsed once at `start` and kept in the ledger; `--set … --apply` replaces them and rewrites the brief still waiting for its agent (without `--apply` it only shows the new list) | none |

Exit 0: `next` is printed. Exit 1: the lane stopped (or, for `gate`, the gate is red). Exit 2: usage or a
refusal, nothing changed (an out-of-order step, a missing report file, a dirty worktree at the gate, a run from
inside a worktree instead of the main checkout).

Every step prints readable text; `--json` prints one object instead. Its fields (the text has the same names): `id`, `step`, `next`, `state`, `worktree`, `branch`, `reportPath`, `guards`, `nested`; for a dispatch
`prompt`, `brief`, `role`, `mode` (`fresh` or `resume`), `agent` (the one to resume), `dispatch` (the agent type,
a suggestion for builders), `after` (the step to run when the agent returns); `run` for `gate` and `close`;
`reason` on a stop; `why` for the machine's choice; `board` for what the lifecycle wrote or skipped; `owned` (each file, `new` when the worktree has none) and `amend` at `start`; `gates`
(`gate` and `verdict`) for the runs on this tip: "1 green, 1 red on this tip". A tip with both is the
conductor's call; a red that failed only in listed flaky tests is marked as such.

### The rounds

| From | Report | Next |
| :--- | :--- | :--- |
| start | | `build`: a fresh builder |
| build, fix | main's HEAD or files changed (any status) | `stop` |
| build, fix | `DONE` / `DONE_WITH_CONCERNS`, uncommitted files or no commits past base | `fix` with the reason (resume); the same again → `stop` |
| build, fix | `DONE` / `DONE_WITH_CONCERNS`, guards hold | `verify` (fresh) when there is no verdict yet; `recheck` (resume the last verifier) after a fix |
| build, fix | `NEEDS_CONTEXT` | `needs-context` once (resume, with the fact), then `stop` |
| build, fix | `BLOCKED` | `stop` |
| any | no status line / no `Verdict:` last line | `resend` (resume) once per role in the lane, then `stop` |
| verify, recheck, final | the branch tip moved since the dispatch | `recheck`: the verdict is void, nothing written; the 3rd void → `stop` |
| verify | `PASS` / `PASS WITH NOTES` | `gate` when no green worktree gate is on this tip, then `close` |
| recheck | `PASS` / `PASS WITH NOTES` | `final`: a fresh verifier against the full acceptance |
| final | `PASS` / `PASS WITH NOTES` | `gate`, then `close` |
| final | `FAIL` | `stop` |
| verify, recheck | `FAIL`, fewer than 3 verdicts | `fix` (resume the builder) |
| verified `PASS WITH NOTES` | `lane exec fix <id> --notes N1,N3` | `fix` (resume the builder) on those notes, then `recheck` |
| verify, recheck | `FAIL` at the 3rd verdict | `stop`: report every verdict to the owner |
| gate | red, or the branch moved since the verdict | `stop` |
| gate | red only in `gate.flaky` tests | the same gate step runs again alone, once; its record decides |

A void verdict doesn't count toward the three verdicts; voids have their own cap of three. A recheck `PASS`
at the third verdict still goes to `final`, so a lane can hold four verdicts: the cap of three stops FAILs,
not the fresh final pass. Every budget is the lane's, so no mix of outcomes resets one: one resend per role,
one `needs-context` round, and a guard fix (resent or not) that trips a guard again stops. Every lane ends in
`close` or `stop`. With no `gate` in the process file, a `PASS` closes on the verdict and the output says so.

### Dispatching

- The prompt is the two lines the step printed, verbatim: the marker `agentry-task: <id> role=<build|verify>
  round=<n>`, then "Read your brief first: <path>…". Everything else is in the brief.
- `fresh`: a new agent of the type `dispatch.agent` names. For a build, `designer` is suggested when an owned
  path is UI-shaped, `implementer` otherwise; the conductor decides. No worktree isolation option: Agentry
  made the worktree, and the brief holds the agent to it.
- `resume`: continue the agent `agent` with the prompt (Claude Code: SendMessage to it; opencode: the same
  `sessionID`). Pass its id as `--agent` on `report` / `verdict` so a later round can resume it. When it can't
  be resumed, dispatch fresh: the brief stands alone, and the worktree is the same.
- The agent writes its full report to `reportPath` and replies with it. If the file is missing or empty, save
  the reply there before running `after`.
- `needs-context`: if the fact is in the contract block, the repo or memory, append it at the end of the brief
  under `## The fact` (the `todo` line says where), then send the prompt. Otherwise ask the owner first. The lane
  allows one such round.
- `gate` and `close` run in the foreground; read the exit code. Only a gate longer than the host's foreground
  limit runs in the host's background mode: wait for its one exit notice and read the same exit code (no
  polling, no piping). The record is written at exit either way.

### Guards

- **Main touched.** Checked at each builder report, content-exact. `start` records main's HEAD and the content
  (git blob id) of every file dirty there; every lifecycle write a lane makes records the file and its content
  before and after (`boardWrites` in its ledger). A main file may differ from the lane's start only when its
  content is reached from its start content, or from what a recorded merge committed, through recorded
  lifecycle writes, by this lane or any other. So parallel lanes never trip each other, and anything else is a
  breach: another row or cell of the board, free text, a file outside the board, a file dirty at start that
  changed or was reverted since. HEAD may move only by other lanes' merges, each the run `preHead` → landed
  commits → board commit its ledger records, matched against main's first-parent history. Agentry's own files
  are not checked: `.agentry/run/`, and new memory records (`.agentry/memory/<facts|episodes>/<slug>-<ULID>.md`,
  untracked, or in a commit that only adds them), the same definition `lane merge` and the gate use for a
  clean main (one function, `own-memory.mjs`). Anything else under the store is a breach: another file, a
  record staged as new, an edit of a tracked record. So a memory write that rewrites a committed fact
  (reinforce, feedback) stops the lane by design: commit it between lanes, not during one. A path's
  type and mode count with its content (a symlink, a chmod).
  `board add` and `board set --apply` run in the main checkout record what they wrote the same way
  (`.agentry/run/process/board-writes.jsonl`), so a night call written with them stops no lane; a hand edit
  of the same file still does. Files the process file lists in `guard.allow` (a status file, a docs folder)
  may change uncommitted while lanes run, except a file a running lane's contract owns: an edit there still
  stops the lane. So: board edits through `board add` / `board set --apply`, never by hand, and no commits
  on main while a lane builds.
- **Trust boundary.** The guard catches a builder that slips into the main checkout; it is not a sandbox. It
  trusts `.agentry/run/` as Agentry's steps wrote it and checks each ledger's claims against git where git can
  say, so a planted ledger naming a SHA excuses nothing. A builder that forges a whole merge record, or edits
  ledgers on purpose, is beyond a guard on a cooperating agent: read the diff when a trip, or its absence,
  looks wrong.
- **The worktree.** A builder leaves no uncommitted or untracked files and at least one commit past base.
- **The tip.** A verdict counts only for the tip it was dispatched on: nobody rebases while a verifier reads.
- **Nested worktrees.** A worktree inside the lane's own worktree is listed in `nested` on every step. Name
  it to the owner. A worktree made elsewhere (the conductor's own) is not the lane's.
- **Writers.** `start` refuses when the ledgers in `building` / `fixing` plus worktrees no ledger owns reach
  `lanes.maxWriters` (`.agentry/config.json`, default 3), and names each one. Worktrees the repo keeps
  (`worktrees.keep`) and the host's agent worktrees (`.claude/worktrees/`) without a ledger are not counted.

### The briefs

`lane exec` renders each round's brief from `references/briefs/` into the task's run dir
(`.agentry/run/process/runs/<id>/`): `build.md`; `fix.md` (wraps the build brief: the verifier's fix list, a
refused report, or the supplied fact); `verify.md` (with a recheck section when resuming); `final.md` (wraps the
verify brief). Each brief carries the contract block verbatim, the owned files, the decisions it cites quoted
from the board's decision kind by id, the facts recalled for the owned files when `memory.prime` is `all` (from
this repo's store and the user's `scope: user` facts only, never another project's), the worktree, the gate
line, the log dir and the report path. The rules builders and verifiers follow live in those
templates, once:

- `cd '<worktree>' &&` on every shell command (single-quoted); absolute paths under the worktree.
- Checks in the foreground, exit codes read, never piped into `grep` / `tail` to decide; no self-started
  background waits. The one exception is the gate rule above: a check longer than the host's foreground limit
  runs in the host's background mode, read by the same exit code.
- Logs and scratch files only under the round's log dir.
- Commits on `agentry/<id>` with no AI attribution; no merge, push or rebase.
- The verifier changes and commits nothing, runs the printed gate line, states the bar for any input or
  interaction before testing it, and names each probe so the fix round commits it as a test.

### Close and handoff

After `close`, call `episode_write` with the printed `episode` (add a `lesson` when the run taught one), then
stamp its id with `close <id> --episode <id>`. The stamp says whether the memory store holds that episode
(`stored`); on `false` it carries a `warning`: check the id `episode_write` returned and tell the owner. A
second `close` on a stamped lane says the episode is already written: write nothing more, and stamping a different id is refused (the stamped one is named). The lane stays `verified` until `/agentry:merge` lands it. Hand off:

```text
<id>: <last verdict>; gate <green|red> <tier> on <sha>
Worktree: <path>  Branch: <branch>
Rounds: <steps, from show>
Notes: <PASS WITH NOTES items, builder concerns, guards, nested worktrees>
Left: /agentry:merge <id>, and anything out of scope
```

## ask

Dispatch exactly one specialist, chosen by where the answer lives:

| Question | Specialist |
| :--- | :--- |
| How this repo works, where something lives, why it behaves as it does (default) | explorer |
| The answer is outside the repo: a library's current API, a standard, an external service | researcher |
| A design question: how something should be structured, which approach fits | architect |

No `isolation: "worktree"`, no run handle.

```text
Answer this question; change nothing.
<the question>

Answer in your reply. No edits, no commits, no files written (no plan, ADR or research doc, nothing under
.agentry/), no memory writes, no Flow calls.
Cite every claim: path:line for code, a URL for outside sources. Say what you could not verify.
```

Relay the answer with its citations. If the question turns out to be a request to change something, say so and
point to `/agentry:exec` or `/agentry:go` rather than building.
