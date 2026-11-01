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
| `gate <id>` | runs the repo's `gate` in the worktree as argv, records `{commit, tree, exit, clean before and after, log}` | none |
| `close <id> [--episode e]` | prints the `episode_write` payload; `--episode` stamps the id it returned | none (`done` comes at merge) |
| `show <id>` | the ledger and the pending dispatch, for a cold resume | none |

Exit 0: `next` is printed. Exit 1: the lane stopped (or, for `gate`, the gate is red). Exit 2: usage or a
refusal, nothing changed (an out-of-order step, a missing report file, a dirty worktree at the gate, a run from
inside a worktree instead of the main checkout).

The JSON: `id`, `step`, `next`, `state`, `worktree`, `branch`, `reportPath`, `guards`, `nested`; for a dispatch
`prompt`, `brief`, `role`, `mode` (`fresh` or `resume`), `agent` (the one to resume), `dispatch` (the agent type,
a suggestion for builders), `after` (the step to run when the agent returns); `run` for `gate` and `close`;
`reason` on a stop; `why` for the machine's choice; `board` for what the lifecycle wrote or skipped.

### The rounds

| From | Report | Next |
| :--- | :--- | :--- |
| start | | `build`: a fresh builder |
| build, fix | main's HEAD or files changed (any status) | `stop` |
| build, fix | `DONE` / `DONE_WITH_CONCERNS`, uncommitted files or no commits past base | `fix` with the reason (resume); the same again → `stop` |
| build, fix | `DONE` / `DONE_WITH_CONCERNS`, guards hold | `verify` (fresh) when there is no verdict yet; `recheck` (resume the last verifier) after a fix |
| build, fix | `NEEDS_CONTEXT` | `needs-context` once (resume, with the fact), then `stop` |
| build, fix | `BLOCKED` | `stop` |
| any | no status line / no `Verdict:` last line | `resend` once (resume), then `stop` |
| verify, recheck, final | the branch tip moved since the dispatch | `recheck`: the verdict is void, nothing written |
| verify | `PASS` / `PASS WITH NOTES` | `gate` when no green worktree gate is on this tip, then `close` |
| recheck | `PASS` / `PASS WITH NOTES` | `final`: a fresh verifier against the full acceptance |
| final | `PASS` / `PASS WITH NOTES` | `gate`, then `close` |
| final | `FAIL` | `stop` |
| verify, recheck | `FAIL`, fewer than 3 verdicts | `fix` (resume the builder) |
| verify, recheck | `FAIL` at the 3rd verdict | `stop`: report every verdict to the owner |
| gate | red, or the branch moved since the verdict | `stop` |

A void verdict doesn't count toward the three. With no `gate` in the process file, a `PASS` closes on the
verdict and the output says so.

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
- A gate can outrun a host's foreground timeout: run `gate` in the host's background mode and wait for its one
  exit notice. The record is written at exit either way.

### Guards

- **Main touched.** At each builder report, main's HEAD and working files must match the lane's start, Agentry's
  own run files and the board files the lifecycle writes excepted. A HEAD move made only of commits another lane's
  merge recorded is not a breach. Don't commit on main by hand while a lane builds.
- **The worktree.** A builder leaves no uncommitted or untracked files and at least one commit past base.
- **The tip.** A verdict counts only for the tip it was dispatched on: nobody rebases while a verifier reads.
- **Nested worktrees.** A worktree that appears during the lane and belongs to no ledger is listed in `nested`
  on every step. Name it to the owner.
- **Writers.** `start` refuses when the ledgers in `building` / `fixing` plus worktrees no ledger owns reach
  `lanes.maxWriters` (`.agentry/config.json`, default 3), and names each one.

### The briefs

`lane exec` renders each round's brief from `references/briefs/` into the task's run dir
(`.agentry/run/process/runs/<id>/`): `build.md`; `fix.md` (wraps the build brief: the verifier's fix list, a
refused report, or the supplied fact); `verify.md` (with a recheck section when resuming); `final.md` (wraps the
verify brief). Each brief carries the contract block verbatim, the owned files, the decisions it cites quoted
from the board's decision kind by id, the facts recalled for the owned files when `memory.prime` is `all`, the
worktree, the gate line, the log dir and the report path. The rules builders and verifiers follow live in those
templates, once:

- `cd <worktree> &&` on every shell command; absolute paths under the worktree.
- Checks in the foreground, exit codes read, never piped into `grep` / `tail` to decide; no self-started
  background waits.
- Logs and scratch files only under the round's log dir.
- Commits on `agentry/<id>` with no AI attribution; no merge, push or rebase.
- The verifier changes and commits nothing, runs the printed gate line, states the bar for any input or
  interaction before testing it, and names each probe so the fix round commits it as a test.

### Close and handoff

After `close`, call `episode_write` with the printed `episode` (add a `lesson` when the run taught one), then
stamp its id with `close <id> --episode <id>`. The lane stays `verified` until `/agentry:merge` lands it. Hand off:

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
