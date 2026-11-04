# Lanes: `exec` and `ask`

Reference for the `conducting` skill. A lane is an explicit command for work whose shape is already known, so it
skips routing. `/agentry:exec <task-id>` builds a contract that already exists (a debt id such as `DEBT-2` too); `/agentry:ask <question>` answers
a question. `/agentry:go` stays the full pipeline and never routes to a lane on its own.

## What a lane never does

- No right-sizing, no spec, plan or split step, no spec or plan gate. The planning already happened.
- No files under `.agentry/work/` (`spec.md`, `plan.md`, `tasks/*.md`).
- No board edits by hand and no contract edits. The exec steps write the board through the workflow file's
  `lifecycle`; a repo without one gets no writes.
- No merge, no push: `/agentry:merge` lands the work.

## exec

The lane's state is a ledger, `.agentry/run/process/ledger/<id>.json` in the main checkout, stepped by
`agentry lane exec <step> <id>` (`scripts/lane.mjs`). Each step checks that the ledger expects it, does the git and board
work, writes the ledger and prints one JSON object. The conductor runs the step `next` names and dispatches the
prompt the step printed. It never composes a brief, picks the next round or writes the board itself.

The id is any item of a kind exec runs: the lifecycle's kind (tasks), or a kind in the workflow file's
`exec.kinds` (debt). Every step reads it in any case (`debt-2` is `DEBT-2`), and an id two kinds hold is
refused (exit 2). The ledger's `kind` records which. A debt item gets the same status, verdict and failed
writes in its own row, and no sprint is read. Its contract is light: an Owns line naming at least one path and
a bold Acceptance line with text; `start` refuses one without either, before any worktree or board write.
An open debt lane and an open task lane pass each other's board writes.

| Step | Does | Board (through `lifecycle`) |
| :--- | :--- | :--- |
| `start <id> [--cite A40,A41]` | finds the contract, refuses at `lanes.maxWriters` and a contract whose Steps part has a problem, cuts `agentry/<id>` in `.agentry/run/worktrees/<id>`, briefs the builder on the first run of steps (`steps:` lists them); `--cite` adds decisions to every brief by id (a decision whose row names the task is quoted anyway) | `dispatched` |
| `report <id> [--agent a]` | reads the builder's report, runs the guards, briefs the next round; a run that ends at `→ owner OK` holds the lane instead | `built` when a verifier (or, under `exec.verify`, the gate alone) is next |
| `verdict <id> [--agent a]` | reads the verifier's report and its tip, briefs the next round | the verdict (`FAIL` also `failed`) |
| `gate <id>` | picks the tier: the `verify` role's while a verifier is out (`expects` is `verdict`), else the `build` role's (`gate.roles`, on the files the branch changed since its base and the item's flag); under `verify: none` a call while a verifier is out exits 2, runs nothing and records nothing: the verifier reads the recorded gate, and the build tier runs after the verdict. Else waits for the gate lock, runs that tier's argv in the worktree, records `{role, tier, command, commit, tree, exit, clean before and after, log}`; a red whose log (or `gate.flakyLogs` files) fails only in `gate.flaky` tests is re-run alone once and both runs are recorded; a gate that queues writes `waiting for gate slot N (held by <who> since HH:MM)` and `slot acquired` to its log, and its output streams there as it runs | none |
| `fix <id> --notes N1,N3` | after `PASS WITH NOTES` (gate or close next): a builder round (resume) on those notes of the verifier's report, then the usual `recheck` | none |
| `close <id> [--episode e]` | prints the `episode_write` payload; `--episode` stamps the id it returned | none (`done` comes at merge) |
| `show <id>` | the ledger and the pending dispatch, for a cold resume | none |
| `owns <id> [--set a,b] [--apply]` | the owned files every brief names, parsed once at `start` and kept in the ledger; `--set … --apply` replaces them and rewrites the brief still waiting for its agent, keeping any section appended after the brief's last template section such as `## The fact` (without `--apply` it only shows the new list; a held lane has no brief waiting: the round after the resume reads the new list) | none |
| `hold <id> --for owner [--evidence <path>] [--agent a]` | a builder's round whose reply is saved waits for the owner's review (`--agent` names the builder out on it, so the resume goes back to that agent) (also on a lane with no steps: the owner looks mid-build); the evidence defaults to that round's report; on a held lane it replaces `for` and the evidence and keeps `since` | none |
| `hold <id> --for later [--note "<why>"]` | parks a lane whose builder was stopped mid-round: no saved reply needed, the worktree kept as it is (uncommitted files allowed); a touched main does not refuse it: the park is recorded and prints `main moved while parked: <reason>; resume re-checks it` | none |
| `resume <id> --note "<the OK>" [--redo] [--fresh]` | records the owner's answer with its time (`holds[]`), then dispatches `continue` to the held round's builder, or after the last step the verifier (or the gate); `--redo` builds the same run again and holds at its end; `--fresh` sends a fresh builder the same brief | `built` when a verifier (or the gate) is next |

Exit 0: `next` is printed. Exit 1: the lane stopped (or, for `gate`, the gate is red). Exit 2: usage or a
refusal, nothing changed (an out-of-order step, a missing report file, a dirty worktree at the gate, a run from
inside a worktree instead of the main checkout).

`hold` refuses (exit 2) a lane whose builder's round is not out ("hold is for a builder's round", with its
state and next), `--for owner` before the reply is saved ("the builder is still out: save its reply to
<reportPath> first, then hold"), any other `--for` ("--for takes owner or later"), an `--evidence` path with
no file, and, for `--for owner`, a touched main (it names the report step, which stops the lane); a park
(`--for later`) goes through on a touched main and says so, since `resume` checks main again. `resume` refuses a lane that is
not held, a resume with no `--note` ("resume needs --note"), `--redo` after a hold during a round ("--redo
goes back over a finished run"), a builder it would send at `lanes.maxWriters` (the `start` message), and a
main changed while the lane was held ("main changed while <id> was held: <reason>: undo that, then
resume").

Every step prints readable text; `--json` prints one object instead. Its fields (the text has the same names): `id`, `step`, `next`, `state`, `worktree`, `branch`, `reportPath`, `guards`, `nested`; for a dispatch
`prompt`, `brief`, `role`, `mode` (`fresh` or `resume`), `agent` (the one to resume), `dispatch` (the agent type,
a suggestion for builders), `after` (the step to run when the agent returns); `run` for `gate` and `close`;
`reason` on a stop; `why` for the machine's choice; `board` for what the lifecycle wrote or skipped; `owned` (each file, `new` when the worktree has none) and `amend` at `start`; `gates`
(`gate` and `verdict`) for the runs on this tip: "1 green, 1 red on this tip", and "1 green, then 1 red on
this tip: the latest is red" when a red came after the green. A tip with both is the conductor's call; a red
that failed only in listed flaky tests is marked as such. `steps` (`start`, `show`): one line per step,
`1. <text> → owner OK`; `holds` (`show`): one line per answer.

A held lane prints these two lines after the header (`<id> · <step> → resume (held)`) on `report`, `hold`
and `show`:

```text
held: for the owner, after step 1 of 2, since <ISO> · evidence <path>
run: agentry lane exec resume <id> --root '<root>' --note "<the OK>"
```

The hold reads `during steps 2–3 of 3` for a hold during a round, `mid-build` with no steps, and
`parked, since <ISO>: "<why>"` for `--for later`. `resume` prints `approved: step 1 of 2 at <ISO>: "<note>"`
(`sent back:` with `--redo`, `noted:` after a hold during a round or a parked one). Under `--json` the same names, `held`,
`steps` and `holds` as strings. `show` on a lane in `building` or `fixing` with no change in its worktree
for 20 minutes (the newest of the round's dispatch, the branch's last commit and the mtime of every file git
does not ignore, so a builder just sent back is never idle)
prints right after the header:

```text
idle: <id> 2h13m: last change 11:44 (<file>) → check the builder; agentry lane exec hold <id> --for later to park it
```

Under `--json` that is `idle: { minutes, lastChange, file }`.

### The rounds

| From | Report | Next |
| :--- | :--- | :--- |
| start | | `build`: a fresh builder |
| build, fix | main's HEAD or files changed (any status) | `stop` |
| build, fix | `DONE` / `DONE_WITH_CONCERNS`, uncommitted files or no commits past base | `fix` with the reason (resume); the same again → `stop` |
| build, fix | `DONE` / `DONE_WITH_CONCERNS`, guards hold | `verify` (fresh) when there is no verdict yet; `recheck` (resume the last verifier) after a fix |
| build, fix | the same, no verdict yet, `exec.verify` is `flagged` or `none`, the item's flag is not set and the workflow file has a gate | `gate` (built is written), then `close`: no verifier. A flagged item is verified as above; a red gate stops the lane |
| build, fix | `NEEDS_CONTEXT` | `needs-context` once (resume, with the fact), then `stop` |
| build, fix | `BLOCKED` | `stop` |
| any | no status line / no `Verdict:` last line | `resend` (resume) once per role in the lane, then `stop` |
| verify, recheck, final | the branch tip moved since the dispatch | `recheck`: the verdict is void, nothing written; the 3rd void → `stop` |
| verify | `PASS` / `PASS WITH NOTES` | `gate` when no green worktree gate is on this tip, then `close` |
| recheck | `PASS` / `PASS WITH NOTES`, `exec.final: "always"` | `final`: a fresh verifier against the full acceptance |
| recheck | `PASS` / `PASS WITH NOTES`, `exec.final: "never"` | `gate`, or `close` when green on this tip |
| recheck | `PASS` / `PASS WITH NOTES`, `exec.final: "after-fix"`, `covered` and `onlyFixCommits` | `gate` / `close`: no final |
| recheck | `PASS` / `PASS WITH NOTES`, `exec.final: "after-fix"`, otherwise | `final` |
| final | `PASS` / `PASS WITH NOTES` | `gate`, then `close` |
| final | `FAIL` | `stop` |
| verify, recheck | `FAIL`, fewer than 3 verdicts | `fix` (resume the builder) |
| verified `PASS WITH NOTES` | `agentry lane exec fix <id> --notes N1,N3`, notes rounds used < `exec.noteRounds` | `fix` (resume the builder) on those notes, then `recheck` |
| verified `PASS WITH NOTES` | notes rounds used = `exec.noteRounds` (0 under `lean`) | the lane goes on to `gate` / `close`; the notes are kept as `openNotes`; `fix --notes` exits 2 naming `exec.noteRounds` |
| verified (next `close` or `merge`) | `agentry lane exec rebase <id>` (a land conflict names it) | `rebase` (resume the last builder): rebase `agentry/<id>` onto main, change nothing else |
| verified, the branch already on main past `closedTip` | `agentry lane exec rebase <id>` | recorded as rebased, no builder round; then as a rebase report below |
| rebase | `DONE` / `DONE_WITH_CONCERNS`, guards hold, the range-diff changed, `exec.rebase: "recheck"` | `resolve`: a fresh verifier reads only the range-diff's changed pairs |
| rebase | `DONE` / `DONE_WITH_CONCERNS`, guards hold, otherwise | `gate` on the new tip, or `close` when green on it |
| rebase | a guard trips / `NEEDS_CONTEXT` | `rebase` again with the reason, twice → `stop` / `stop` |
| resolve | `PASS` / `PASS WITH NOTES` | `gate` / `close` (no notes round) |
| resolve | `FAIL` | `stop`: the conflict resolution failed its check |
| resolve | the branch tip moved since the dispatch | void, `resolve` again (counts toward the three voids) |
| verified with no verdict (the route skipped the verifier) | `agentry lane exec reverify <id>` | `verify` (fresh), then the rows above |
| verify, recheck | `FAIL` at the 3rd verdict | `stop`: report every verdict to the owner |
| gate | red, or the branch moved since the verdict | `stop` |
| gate | red only in `gate.flaky` tests | the same gate step runs again alone, once; its record decides |
| start, the contract has steps | | `build` (fresh) on the first run: steps 1..g, g the first step ending `→ owner OK`, else the last |
| build, fix, continue on run a..g, no verdict yet | `DONE` / `DONE_WITH_CONCERNS`, guards hold | held (`next resume`) when step g ends `→ owner OK`; else g is the last step and the work goes on as a build does |
| build, fix, continue on run a..g (a > 1, or any run the owner sent back with `--redo`) | no commits since step a began (for a redo, since the redo was dispatched) | `fix` (resume) with the reason, as the other worktree guards |
| a builder's round is out | `agentry lane exec hold <id> --for owner\|later` | held; the round is left unread (`held: true`) |
| held | `agentry lane exec resume <id> --note "…"` | `continue` (resume the builder) on the next run; on the same run after a hold during a round, or with `--redo`; after the last step `verify` (fresh), or the gate under `exec.verify` |
| held | a report, verdict or notes fix | refused: the lane expects a resume; a gate run is recorded and decides nothing |

A run is the steps from a to g, g the first step from a with an owner gate, else the last step: the steps
with no gate between them are built in one round. A lane without steps is one run of the whole contract and
behaves as it always has; so does an older ledger. The owner's answers spend no budget: a hold waits, and the
resume picks up where the lane was. One fresh verifier reads the whole contract after the last step.

The route is fixed at `start`: the ledger keeps `route: { verify, flagged, preset, noteRounds, final, rebase }`
(the workflow file's `exec` keys as its preset resolves them), so an edit of the workflow file changes no
running lane, and a ledger without these keys runs on the `standard` values. `exec start` and `show` print
the `workflow:` line, `show` also `route fixed at start: …`, and `route: all (fixed at start; workflow.json
now says flagged)` when the file says otherwise now. A task flagged after its start is still read by a
verifier when the lane routes it at its report; one closed with no verifier before the flag was set is
refused at the land: run `agentry lane exec reverify <id>`. `exec.idleMinutes` is read live from the file.

A recheck's facts are computed by the lane and pinned on the round: `covered` (every note sent back, the
picked labels or every `N<k>` of the FAIL report, has an `N<k>: PASS` line and no `N<k>: FAIL` line in the
recheck report, outside a fenced block; none sent back is not covered) and `onlyFixCommits` (the last
verdict's tip is an ancestor of this one and no merge commit lies between). A rebase report runs the guards
from the new merge base, sets `base` to it and writes `logs/range-diff-<n>.txt` (`changed` when a pair is not
marked `=`, or git cannot compute it); `rebases[]` keeps `{ fromBase, fromTip, toBase, toTip, changed,
rangeDiff }`, written before the dispatch so a killed `exec rebase` reruns on its entry. A report while a
rebase is still in progress in the worktree is refused. A verdict that lets the lane go on sets `openNotes` to
its report's notes; a recheck also keeps the earlier open notes it did not pass, while a verify or final verdict,
which reads the whole contract, replaces them. Every time the lane settles `close` it writes
`closedTip`; the land refuses a branch moved past it.

A void verdict doesn't count toward the three verdicts; voids have their own cap of three. A recheck `PASS`
at the third verdict still goes to `final`, so a lane can hold four verdicts: the cap of three stops FAILs,
not the fresh final pass. Every budget is the lane's, so no mix of outcomes resets one: one resend per role,
one `needs-context` round, and a guard fix (resent or not) that trips a guard again stops. Every lane ends in
`close` or `stop`. With no `gate` in the workflow file, a `PASS` closes on the verdict and the output says so.

### Steps in a contract

A contract may split its work into steps the lane builds in order, with the owner's review between them:

```markdown
- **Steps:**
  1. Build the parser → owner OK
  2. Wire it into the CLI
  3. Document it
- **Acceptance:**
  - Step 1: the parser test passes
  - the whole suite is green
```

The part opens at a `**Steps:**` / `**Steps**:` label or a `Steps` heading of any level and holds one numbered
item per line (`1.` or `1)`); an indented line joins the item above; it ends at the next bold label or heading.
An item ending `→ owner OK` or `-> owner OK` (any case, optional period) has an owner gate. Under the Acceptance
label or heading, a list item that starts `Step N:` is step N's (the tag cut); every other item is the whole
contract's. `start` refuses a Steps part with a problem, named exactly: `steps must be numbered 1 to N with no
gap (found 1, 3)`, `the Steps part has no numbered items, one per line`, `acceptance names step 3; the contract
has 2 steps`. `agentry board contract <id>` prints `steps` (and `stepsProblem`) with the block.

The ledger keeps `steps` from `start`; each builder round before the first verdict carries `stepRun: [a, g]`.
A held lane has `state: "held"`, `next: "resume"` and `hold: { for, when, stepRun, evidence, since, round }`
(`when` is `after` at a run's end, `during` for a hold the conductor made); each resume appends `{ for, when,
stepRun, evidence, since, resumedAt, note, redo }` to `holds[]`.

A run that ends at an owner gate holds the lane by itself, and says why: "the owner reviews step 1 of 2
before the lane goes on". Show the owner the `held:` line and the evidence, and wait: run the `run:` line with the
owner's own words as `--note` once they answer. "Change it first" is `--redo`. Never resume on the owner's
behalf. The owner can also look in while a builder works: once its reply is saved, `hold --for owner` holds
the lane during the round, and the resume carries the same round on.

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
- `continue` (after a resume): send `prompt` to `agent` (resume it). It is a fresh dispatch only when the
  held round had no agent, or with `resume --fresh` because that agent is gone.
- A builder that stops answering: `show` flags a lane idle after 20 minutes with no change. Check on the
  builder; if it is gone, `hold <id> --for later` parks the lane (its worktree is kept as it is), and
  `resume <id> --note "<why>" --fresh` sends a fresh builder, whose brief says to read `git status` first.
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
  untracked, or in a commit that only adds them), the same definition `agentry lane merge` and the gate use for a
  clean main (one function, `own-memory.mjs`). Anything else under the store is a breach: another file, a
  record staged as new, an edit of a tracked record. So a memory write that rewrites a committed fact
  (reinforce, feedback) stops the lane by design: commit it between lanes, not during one. A path's
  type and mode count with its content (a symlink, a chmod).
  `agentry board add` and `agentry board set --apply` run in the main checkout record what they wrote the same way
  (`.agentry/run/process/board-writes.jsonl`), so a night call written with them stops no lane; a hand edit
  of the same file still does. Files the workflow file lists in `guard.allow` (a status file, a docs folder)
  may change uncommitted while lanes run, except a file a running lane's contract owns: an edit there still
  stops the lane. A commit on main's first-parent line passes too when every path it touches matches
  `guard.allow` and none is owned by a running lane (`building`, `fixing`, `verifying`, `held`); the report's
  `guards` line says `main moved by allowed commits: <n> (<short shas>)`. Agentry's config in use, the process
  file and its workflow file (`.agentry/process.json`, `.agentry/workflow.json`, or the `--process` file and
  its sibling), counts as a `guard.allow` path for every check, committed or not, with or without a
  `guard.allow` key, unless a running lane's contract owns it. A commit touching any other path,
  or an owned allowed path, trips with `HEAD moved …` plus `(<path> is not in guard.allow)` or
  `(<path> is owned by <lane>)`. So: board edits through `agentry board add` / `agentry board set --apply`,
  never by hand, and no other commits on main while a lane builds. A held lane's owned files stay protected for the other
  lanes; `resume` checks main the same way, so an edit made while a lane was held is undone before it goes on.
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
  A held or parked lane is not a writer (its worktree is owned by its ledger), so another lane may start while
  it waits; a `resume` that sends a builder is refused with the same message while the cap is reached.
- **A held lane.** Hold, resume and a run's end write nothing on main and no board cell: `built` is written
  once, when the verifier (or the gate) is next. `/agentry:merge` refuses a held lane, `close` refuses it,
  and `agentry lane sweep` keeps its worktree.

### The briefs

`agentry lane exec` renders each round's brief from `references/briefs/` into the task's run dir
(`.agentry/run/process/runs/<id>/`): `build.md`; `fix.md` (wraps the build brief: the verifier's fix list, a
refused report, the supplied fact, or for `continue` the owner's answer); `verify.md` (with a recheck section
when resuming); `final.md` (wraps the verify brief). Each brief carries the contract block verbatim, the owned files, the decisions it cites quoted
from the board's decision kind by id (and the ones whose row names the task, and any given to `start --cite`), the facts recalled for the owned files when `memory.prime` is `all` (from
this repo's store and the user's `scope: user` facts only, never another project's), the worktree, the gate
line, the log dir and the report path. The rules builders and verifiers follow live in those
templates, once:

- `cd '<worktree>' &&` on every shell command (single-quoted); absolute paths under the worktree.
- Checks in the foreground, exit codes read, never piped into `grep` / `tail` to decide; no self-started
  background waits. The one exception is the gate rule above: a check longer than the host's foreground limit
  runs in the host's background mode, read by the same exit code.
- Logs and scratch files only under the round's log dir.
- No command other than the gate runs longer than 10 minutes: an engine, server, simulator or watcher gets a
  time limit (`agentry run --limit <dur> -- …`), and hitting it is a finding to report, never a wait (build and
  verify briefs).
- Commits on `agentry/<id>` with no AI attribution; no merge, push or rebase.
- A contract with steps: the build brief says `## This round: step 1 of 2` (`steps 2–3 of 3`), `Build only
  this part of the contract:` with the run's steps, `It is done when:` with the run's tagged acceptance items,
  `Built before this round (on the branch): step 1.` past the first run, and `Not this round:` with the later
  steps (`none: the verifier then reads the whole contract` on the last run); a run ending at an owner gate adds
  that the lane holds for the owner's review, so the report says what the owner should open or run. A
  `continue` brief quotes the owner's answer with its time and says to go on, rework the same steps, or carry
  on with them; a parked lane's says to read `git status` first. The verify brief lists each approval under
  `The owner reviewed and approved these; judge the rest against the contract, not the owner's call:`.
- When the latest worktree gate run on the dispatched tip and tree is green and of the tier the verify (or
  build) role runs, the verify, recheck and final briefs say `the gate is recorded green on <sha> (<log>):
  read it; do not re-run it` and the verifier runs only its own probes. Without one, under
  `gate.roles.verify: none` they say `The gate is not yours: the lane records the <build> tier and the land
  runs the merge tier. Run only your own probes.`; otherwise (a moved tip, a red run after the green, a
  verify role that runs a tier) the full gate line. `exec gate` run while a
  verifier is next rewrites that waiting brief, whatever the gate's exit. Each dispatch prints `model:` when `models` in the workflow file names one for its role (builder:
  `build`; verifier: `verify.flagged`, `verify.ui` when a designer builds, else `verify.default`).
- The verifier changes and commits nothing, runs the printed gate line (or reads the recorded one), states the bar for any input or
  interaction before testing it, and names each probe so the fix round commits it as a test.

### Close and handoff

After `close`, call `episode_write` with the printed `episode` (its outcome says `owner holds: N` when the owner
answered any; add a `lesson` when the run taught one), then
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

No `isolation: "worktree"`.

```text
Answer this question; change nothing.
<the question>

Answer in your reply. No edits, no commits, no files written (no plan, ADR or research doc, nothing under
.agentry/), no memory writes.
Cite every claim: path:line for code, a URL for outside sources. Say what you could not verify.
```

Relay the answer with its citations. If the question turns out to be a request to change something, say so and
point to `/agentry:exec` or `/agentry:go` rather than building.
