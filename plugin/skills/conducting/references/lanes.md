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
| `start <id> [--cite A40,A41]` | finds the contract, refuses at `lanes.maxWriters` and a contract whose Steps part has a problem, refuses while another lane's land has its picks on main (`main is mid-land (<id>, since HH:MM): its picks may still roll back → start after it lands, or …` naming the land's resolve step, exit 2, nothing written), cuts `agentry/<id>` in `.agentry/run/worktrees/<id>`, briefs the builder on the first run of steps (`steps:` lists them); `--cite` adds decisions to every brief by id (a decision whose row names the task is quoted anyway) | `dispatched` |
| `start <id> --on <Y>` | stacks the lane on Y's (see [Stacks](#stacks)), with every `start` check and record (a land mid-pick, `lanes.maxWriters`, the contract, `boardAtStart`): Y resolves like `<id>`, and is `verified` (any next), `held` or at its gate (`next: gate`); cuts `agentry/<id>` from `agentry/<Y>`'s tip, writes `on: "<Y>"` and `base` (Y's tip) to the ledger and prints `stack: on <Y> at <short> (<Y> is <state>); <Y> lands first` | `dispatched` |
| `report <id> [--agent a]` | reads the builder's report, runs the guards, briefs the next round; a run that ends at `→ owner OK` holds the lane instead; a main the guard finds touched holds it for the guard, and on a lane held so it reads the saved report again | `built` when a verifier (or, under `exec.verify`, the gate alone) is next |
| `verdict <id> [--agent a]` | reads the verifier's report and its tip, briefs the next round | the verdict (`FAIL` also `failed`) |
| `gate <id>` | picks the tier: the `verify` role's while a verifier is out (`expects` is `verdict`), else the `build` role's (`gate.roles`, on the files the branch changed since its base and the item's flag); under `verify: none` a call while a verifier is out exits 2, runs nothing and records nothing: the verifier reads the recorded gate, and the build tier runs after the verdict. Else waits for the gate lock, runs that tier's argv in the worktree, records `{role, tier, command, commit, tree, exit, clean before and after, log}`; a red whose log (or `gate.flakyLogs` files) fails only in `gate.flaky` tests is re-run alone once and both runs are recorded; a gate that queues writes `waiting for gate slot N (held by <who> since HH:MM)` and `slot acquired` to its log, and its output streams there as it runs | none |
| `fix <id> --notes N1,N3` | after `PASS WITH NOTES` (gate or close next): a builder round (resume) on those notes of the latest verifier's report or of the ledger's `openNotes` (each quoted from the report that raised it), then the usual `recheck` | none |
| `fix <id> --owner "<the change>"` | the owner sends a `verified` lane (next `close` or `merge`) back: one builder round (the last builder resumed, a fresh one with the brief when none was recorded) whose brief quotes `## The owner's change` with its time, then the lane's own route: under an `exec.verify` route that skipped the verifier, the gate on the new tip, then `close`; otherwise a `recheck` by the last verifier, which judges the change as one more note sent back (`owner: PASS\|FAIL <evidence>`; `owner: PASS` with every other note passed is covered, so under `final: "after-fix"` no final follows). The ledger records `ownerFixes: [{ note, at, round }]` and the episode counts them (`owner fixes: N`). Refused: no `--owner` text, `--owner` with `--notes`, a builder already out, a merged lane, any lane that is not verified | `built` when the round is reported |
| `close <id> [--episode e]` | prints the `episode_write` payload; `--episode` stamps the id it returned | none (`done` comes at merge) |
| `show <id>` | the ledger and the pending dispatch, for a cold resume; on a stopped lane, `stopped: <reason>` and its `ways on:` | none |
| `owns <id> [--set a,b] [--apply]` | the owned files every brief names, parsed once at `start` and kept in the ledger; `--set … --apply` replaces them and rewrites the brief still waiting for its agent, keeping any section appended after the brief's last template section such as `## The fact` (without `--apply` it only shows the new list; a held lane has no brief waiting: the round after the resume reads the new list) | none |
| `hold <id> --for owner [--evidence <path>] [--agent a]` | a builder's round whose reply is saved waits for the owner's review (`--agent` names the builder out on it, so the resume goes back to that agent) (also on a lane with no steps: the owner looks mid-build); the evidence defaults to that round's report; on a held lane it replaces `for` and the evidence and keeps `since` | none |
| `hold <id> --for later [--note "<why>"]` | parks a lane whose builder was stopped mid-round: no saved reply needed, the worktree kept as it is (uncommitted files allowed); a touched main does not refuse it: the park is recorded and prints `main moved while parked: <reason>; resume re-checks it`. Also parks a `verified` lane (next `close` or `merge`): `hold.when: "verified"`, nothing in the worktree or the rounds changes, `show` prints `held: parked, verified, since <ISO>`, `merge` refuses it while held and drift names no `verified-not-merged`; its `resume` makes it `verified` again with the same next step (no builder, the note in `holds[]`); `--for owner` on it is refused ("hold --for owner is for a builder's round") | none |
| `resume <id> --note "<the OK>" [--redo] [--fresh]` | records the owner's answer with its time (`holds[]`), then dispatches `continue` to the held round's builder, or after the last step the verifier (or the gate); `--redo` builds the same run again and holds at its end; `--fresh` sends a fresh builder the same brief. Main is checked by the guard's own rule (see [Guards](#guards)): a main moved only by commits that touch none of the lane's owned files and none of the files its worktree changed (committed past base or uncommitted) passes, printing `moved: main moved by <n> commits, none touching this lane's files: resuming on base <short>` (`<n>` the commits that rule judged: other lanes' landed picks and memory commits are not counted, and with only those nothing is printed); a commit touching them refuses it (`main changed while <id> was held: HEAD moved a → b (<sha> touches <paths>, this lane's files) → agentry lane exec restart <id> --carry`); with no move on main nothing more is printed | `built` when a verifier (or the gate) is next |
| `restack <id> [--main]` | a stacked lane with no agent out (its gate, close or merge next, or held): rebases `agentry/<id>` onto its parent's new tip, or main's once the parent landed (`--main`: onto main whatever the parent's state, the owner's call); writes the branch and the ledger only (see [Stacks](#stacks)). Refused (exit 2, nothing changed) on a lane held by a guard trip (`<id> is held by a guard trip: run its report once main is fixed, then restack`) and on a parked verified lane (`<id> is parked verified: resume it, then restack`); a parent's land leaves such a child as it is and names it with the same line | none |
| `restart <id> [--carry]` | a lane that is not merged, with no agent out (`a builder is out: hold it first`; a verifier out, a gate of it queued or running, a land of it, a lane stacked on an unmerged parent and a lane with an open stacked child (`<child> is stacked on <id>: restack or close it first`) are refused too), started again: refuses while another lane's land has its picks on main (`start`'s check), at `lanes.maxWriters` (the lane itself not counted), when its worktree holds ignored files outside `cleanup.disposable` (and the defaults), naming them, and when the board write `dispatched` would refuse (its row gone): every refusal comes before any write. Past the archive nothing is refused: a failure is a stop (exit 1) naming the archive, the branch that holds the old work and the diff's path. Saves the worktree's uncommitted diff (untracked files too) to `runs/<id>.<n>/restart/uncommitted.diff`, archives the ledger and run dir as `ledger/<id>.<n>.json` and `runs/<id>.<n>/` (`n` one past the highest archive or kept branch, so an older one is never overwritten; a hold's `holds[]` stays in it), removes the worktree, keeps the branch as `agentry/<id>.<n>` and cuts a fresh `agentry/<id>` from main with every `start` record (`boardAtStart` from the spec loaded now, `mainAtStart`, `dispatched`); a verdict on the board (`lifecycle.write.verdict`) is the old lane's, so it is cleared through `board set` (recorded), or, when that fails, a `!` warning says the verdict is from the old lane and names the `board set` call that clears it; prints `restarted: archived as <id>.<n>…`. Without `--carry` the new lane starts clean and the old branch stays. With `--carry` it cherry-picks the old branch's commits (base..tip), then applies the saved diff (`git apply --3way`), and the first build brief gets `## Carried work`: `A previous builder's work is in the tree (<n> commits, <m> files uncommitted). Its last report is <path>: read it first.` (the report in the archive), and when files were carried, that they are applied staged (`git apply --3way` stages them); once all of it is carried the old branch goes, after the new ledger is written. A conflict stops the carry (exit 1): main untouched, the conflict left in the new worktree for the builder (`conflict: <sha> <subject> conflicts in <files>: resolve it, git cherry-pick --continue, then git apply --3way <diff> in <worktree>`, or `the uncommitted diff conflicts in <files>`), named in the brief too, the old branch kept as `agentry/<id>.<n>`. The ledger records `restarted: { from, ledger, runs, branch, at }` and `carried: { commits, files, report, conflict? }` | `dispatched` |

Exit 0: `next` is printed. Exit 1: the lane stopped (or, for `gate`, the gate is red; for `restack`, git
stopped the rebase and it was aborted). Exit 2: usage or a
refusal, nothing changed (an out-of-order step, a missing report file, a dirty worktree at the gate, a run from
inside a worktree instead of the main checkout).

`hold` refuses (exit 2) a lane whose builder's round is not out ("hold is for a builder's round", with its
state and next), `--for owner` before the reply is saved ("the builder is still out: save its reply to
<reportPath> first, then hold"), any other `--for` ("--for takes owner or later"), an `--evidence` path with
no file, and, for `--for owner`, a touched main (it names the report step, which holds the lane for the guard) or a lane
held for the guard ("the lane is held for the guard: fix it and run <the report step>"); a park
(`--for later`) goes through on a touched main and says so, since `resume` checks main again. `resume` refuses a lane that is
not held, a resume with no `--note` ("resume needs --note"), `--redo` after a hold during a round ("--redo
goes back over a finished run"), a builder it would send at `lanes.maxWriters` (the `start` message), and a
main changed while the lane was held ("main changed while <id> was held: <reason>: undo that, then
resume", or, for a commit touching the lane's files, "… → agentry lane exec restart <id> --carry").

Every step prints readable text; `--json` prints one object instead. Its fields (the text has the same names): `id`, `step`, `next`, `state`, `worktree`, `branch`, `reportPath`, `guards`, `nested`; for a dispatch
`prompt`, `brief`, `role`, `mode` (`fresh` or `resume`), `agent` (the one to resume), `dispatch` (the agent type,
a suggestion for builders), `after` (the step to run when the agent returns); `run` for `gate` and `close`;
`reason` on a stop; `why` for the machine's choice; `board` for what the lifecycle wrote or skipped; `owned` (each file, `new` when the worktree has none) and `amend` at `start`; `gates`
(`gate` and `verdict`) for the runs on this tip: "1 green, 1 red on this tip", and "1 green, then 1 red on
this tip: the latest is red" when a red came after the green. A tip with both is the conductor's call; a red
that failed only in listed flaky tests is marked as such. `steps` (`start`, `show`): one line per step,
`1. <text> → owner OK`; `holds` (`show`): one line per answer. A stacked lane adds `stack` on every step,
`restacked` (and `commits`) on `restack`, `restacks` on `show`; a lane others are stacked on shows `stacked on
it`.

A held lane prints these two lines after the header (`<id> · <step> → resume (held)`) on `report`, `hold`
and `show`:

```text
held: for the owner, after step 1 of 2, since <ISO> · evidence <path>
run: agentry lane exec resume <id> --root '<root>' --note "<the OK>"
```

The hold reads `during steps 2–3 of 3` for a hold during a round, `mid-build` with no steps, and
`parked, since <ISO>: "<why>"` for `--for later`. A lane held for the guard prints instead (and `hold`, with
`for: "guard"`, the saved `report` and the `reason`, also under `--json`):

```text
held: guard tripped: <reason> → fix it (commit it between lanes, or add the path to guard.allow), then run agentry lane exec report <id> --root '<root>' again
run: agentry lane exec report <id> --root '<root>'
```

`show` on a stopped lane prints right after the header `stopped: <reason>`, then one `ways on:` line: the
merge that lands the branch as it is (`agentry lane merge <id> --branch agentry/<id>`, the owner's call) ·
`exec restart <id> --carry` (starts it again with its work).

`resume` prints `approved: step 1 of 2 at <ISO>: "<note>"`
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
| build, fix | main's HEAD or files changed (any status) | held for the guard (`next resume`): the round is left unread and its report saved (`<report>.held.md`); nothing in the worktree changes |
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
| held for the guard | `agentry lane exec report <id>` | the guard runs again: main clean → the saved report goes on exactly as the first report would have; still touched → held again with the new reason, `since` the first trip |
| held for the guard | `resume`, `hold --for later` | as on any held lane: `continue` to the round's builder; parked |
| held | a report, verdict or notes fix | refused: the lane expects a resume; a gate run is recorded and decides nothing |
| a stacked lane at its gate, close or merge | `agentry lane exec restack <id>`, resolution `none`, after a verdict (or a `builtTip`) | `gate` (verifying) on the new tip: the verdict stands for the same commits; a gate on the old tip no longer counts |
| a stacked lane at its gate, close or merge | `agentry lane exec restack <id>`, resolution `by hand`, after a verdict | `resolve`: the resolution recheck, a fresh verifier on the restack's range-diff |
| a stacked lane held, no verdict yet | `agentry lane exec restack <id>` | no change: recorded; the one verifier after the build reads it all |

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
`close` or `stop`, or waits in a hold (the owner's, a park, or the guard's until main is fixed). With no `gate` in the workflow file, a `PASS` closes on the verdict and the output says so.

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
(`when` is `after` at a run's end, `during` for a hold the conductor made or the guard's; a guard hold is
`for: "guard"` with its `reason` and the saved `report`); each resume appends `{ for, when,
stepRun, evidence, since, resumedAt, note, redo }` to `holds[]`.

A run that ends at an owner gate holds the lane by itself, and says why: "the owner reviews step 1 of 2
before the lane goes on". Show the owner the `held:` line and the evidence, and wait: run the `run:` line with the
owner's own words as `--note` once they answer. "Change it first" is `--redo`. Never resume on the owner's
behalf. The owner can also look in while a builder works: once its reply is saved, `hold --for owner` holds
the lane during the round, and the resume carries the same round on.

### Stacks

A lane can start on another lane that is done building but not landed yet (A45), so serial work does not
wait for a land: `agentry lane exec start T2 --on T1`. T1 may be `verified` (any next), `held`, or at its gate
(`next: gate`), and may itself be stacked (a chain). T2 is cut from `agentry/T1`'s tip; its ledger has
`on: "T1"` and `base` = that tip, so every `base..HEAD` reader (the commit count, the gate tier, the briefs)
measures T2's own commits only. `mainAtStart`, the writers count and `guard.allow` are as for any lane: T2
counts as a writer while it builds or fixes, a verified or held T1 does not. The owns-overlap warning skips
the parent chain: a file shared with it prints once, `stack: shares with T1: <paths, max 5, then +N>`, instead
of `! owns overlap`. A ledger without `on` behaves as before.

`start --on` refuses (exit 2, nothing changed): `--on names the task itself`; `no lane for <Y>: start it
first (<start line>)`; `<Y> is merged: start <X> without --on (main holds it)`; `<Y> is building: stack on it
once it is verified, held or at its gate`; `<Y> is <state> (next <next>): stack on a lane that is verified,
held or at its gate`; and `--on goes with start only` on any other step.

**What is due.** Every exec step on T2 prints `stack:` right after the header (a held lane's `held:` first):
`stack: on T1 at abc1234` while T1's branch is still at T2's base; `…; T1 moved to def5678 → agentry lane exec
restack T2 --root '<root>'` once it moved (a notes fix on T1); `…; T1 landed → …restack T2…` once T1 is merged;
`…; T1 is stopped: T2 lands only after it, or …restack T2 --main takes it off` when T1 is stopped, closed or
gone. Report, verdict, fix, hold and resume go on (a verdict stays bound to its tip). Only `exec gate` refuses
a due stack (exit 2): `T1 moved since T2 was cut on it (abc1234 → def5678): a gate here would not count →
<restack line>` (`T1 landed since …`, `T1 is stopped since …`).

**Restack.** `agentry lane exec restack T2 [--main]` writes T2's branch and ledger only (no board, no main).
It runs with no agent out (the lane at `gate`, `close` or `merge` next, or held): otherwise `a <role> round is
out (round <n>, next <next>): restack when the lane is at its gate, close or merge, or held`. Two holds come
first: `T2 is held by a guard trip: run its report once main is fixed, then restack` and `T2 is parked
verified: resume it, then restack` (the round machine refuses a restack on either too). It is refused too
while a gate of T2 is queued or running (`a gate for T2 is queued or running: restack after it`: `exec gate`
marks its intent in `.agentry/run/process/gating/T2.json` before it reads the ledger and clears it on any exit)
and on a dirty worktree (`the
worktree <path> is not clean (<entries, max 5>): commit or remove them, then restack`; a rebase still in
progress, a killed restack, leads the entries as `rebase in progress`). The target is T1's tip when T1 moved,
main's tip when T1 landed, or main's with `--main` on any state of T1 (a stopped T1 needs it). With nothing
due it exits 0 with `restack: nothing to do: T2 is on T1's tip <short>` and writes nothing. Git runs as one
argv in the worktree, with the repo's rebase config that could stash, squash or move another branch switched
off: `git -c rebase.autoStash=false -c rebase.autoSquash=false -c rebase.updateRefs=false rebase --onto <onto>
<base>`. A stop is aborted (`rebase --abort`) with the branch, worktree, index and ledger as they were, exit 1:
`✗ lane exec restack T2: <short> <subject> conflicts on <onto name> at <short> (<files, max 5>): aborted,
agentry/T2 is back at <short> → resolve it in <worktree>: git rebase --onto <onto> <base>, then <restack
line>`. Before the rebase the ledger holds the plan, `restacking: { target, onto, ontoName, base, from }`; the
record is written only after the rebase exits 0, and a stop puts the ledger's bytes back. A branch already on the
target (rebased by hand) is recorded `by hand`, and so is one a restack killed after its rebase moved: the rerun
reads the plan, so a parent that moved again since is no trap. Either way the resolution recheck runs, never a
silent pass. Printed on success: `restacked: onto T1 at <short> (was <short>): <n> commit(s), <no conflict | resolved
by hand>; tip <short> → <short>` (onto main: `restacked: onto main at <short> without T1's old commits (T1
landed): …`). Each restack appends `restacks[]: { at, parent, onto: "parent" | "main", from, to, base:
{ from, to }, resolution: "none" | "by hand" }` (and `rangeDiff`, `logs/restack-range-diff-<n>.txt`, for one
by hand) and sets `base` to `base.to`; one onto main removes `on`.

**Rounds.** A clean restack gets the gate only, the trust a land's cherry-pick onto a moved main gets: the
verdict stands for the same commits (`verifiedTip`, the last counted verdict's tip or `builtTip`, carries
through each clean restack from it), and a gate on the old tip no longer counts. One by hand after a verdict
gets the resolution recheck (A48) on the restack's ranges; the resolve brief names the parent's branch. A held
lane with no verdict yet records it and goes on: the one verifier after the build reads it all. The verify
and build briefs of a stacked lane carry a `Stacked` section: judge (or build) only `base..HEAD`, the parent's
commits are its own lane's, and never rebase: the lane restacks. `exec rebase T2` while T1 is not merged is
refused (`T2 is stacked on T1: restack it (agentry lane exec restack T2), never rebase it onto main`).

**Land in order.** `/agentry:merge T2` refuses until T1 has landed and T2 is restacked onto main (see
`merge.md`, the `stack` row). T1's land restacks each child at rest onto main itself, after its board commit,
in id order (`restacked: T2 onto main (<n> commits)`), and leaves a child with an agent out, a gate queued or
running, or a conflict as it was, naming it; the rerun of a land that already finished restacks the children
at rest by the same rule. A gate whose lane moved while it ran (its base, its restacks or its branch tip)
writes nothing and exits 1: `T2 moved while its gate ran (<what moved>): the gate's record is not written →
<gate line>`. A chain lands one lane at a time: T1's land makes T2 due main and T3 (on T2) due its parent.
`show T2` adds `stack:` and `restacks:` (one line each); `show T1` adds `stacked on it: <ids>`. The episode
says `stacked on T1; restacks: N`.

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

- **Main touched.** Checked at each builder report, content-exact; a trip holds the lane for the guard, its
  report saved: fix main (commit it between lanes, or add the path to `guard.allow`) and run `report` again.
  `start` records main's HEAD and the content (git blob id) of every file dirty there; every lifecycle write a lane makes records the file and its content
  before and after (`boardWrites` in its ledger). A main file may differ from the lane's start only when its
  content is reached from its start content, or from what a recorded merge committed, through recorded
  lifecycle writes, by this lane or any other. So parallel lanes never trip each other, and anything else is a
  breach: another row, cell or free text in a board file a running lane owns, a file outside the board, a file
  dirty at start that changed or was reverted since (board files no running lane owns are allowed, below). HEAD may move by other lanes' merges, each the run `preHead` → landed
  commits → board commit its ledger records, matched against main's first-parent history, and by any commit
  that touches none of this lane's owned files and none of the files its worktree changed (committed past base
  or uncommitted), whoever made it (field 81). The commit list is the lane's start..HEAD, judged against its
  owned files at that moment, so removing a one-off `guard.allow` entry never re-trips a lane; a commit
  touching a file only another running lane owns trips that lane, not this one. An overlapping commit trips
  with the overlap named: `HEAD moved a → b (<sha> touches <paths>, this lane's files)` (at most 5 paths,
  `(+<n> more)`). `report`, `hold` and `resume` run this one rule, so they never disagree. Agentry's own files
  are not checked: `.agentry/run/`, and new memory records (`.agentry/memory/<facts|episodes>/<slug>-<ULID>.md`,
  untracked, or in a commit that only adds them). Anything else under `.agentry/memory/` is let through as a
  `guard.allow` glob, committed or uncommitted (field 78), unless a running lane's contract owns it; `agentry
  lane merge` and the gate keep the stricter definition for a clean main (one function, `own-memory.mjs`). A
  path's type and mode count with its content (a symlink, a chmod).
  `agentry board add` and `agentry board set --apply` run in the main checkout record what they wrote the same way
  (`.agentry/run/process/board-writes.jsonl`), so a night call written with them trips no lane; so does a hand
  edit of a board file no running lane owns (below). Files the workflow file lists in `guard.allow` (a status file, a docs folder)
  may change uncommitted while lanes run, except a file a running lane's contract owns: an edit there still
  trips the guard. A commit on main's first-parent line passes too when every path it touches matches
  `guard.allow` and none is owned by a running lane (`building`, `fixing`, `verifying`, `held`); the report's
  `guards` line says `main moved by allowed commits: <n> (<short shas>)` (every commit the guard let through).
  Agentry's config in use, the process file and its workflow file (`.agentry/process.json`,
  `.agentry/workflow.json`, or the `--process` file and its sibling), and `.agentry/config.json`, counts as a
  `guard.allow` path for every check, committed or not, with or without a `guard.allow` key, unless a running
  lane's contract owns it (the uncommitted `guard`/`gate` key check is for the process and workflow files only:
  `config.json` holds neither). So does every board location the process file
  names as main's HEAD commits it, or, when the process file is not tracked there (`.agentry/` kept out of
  git), as it loaded at `start` (`boardAtStart` in the ledger; an older ledger has none): an edit made after
  the lane started widens nothing. From the board root: each kind's `at.table` file, each `contract.blocks`
  file, each `create.blocks[].file`, any file its `at.files` or `file.glob` matches (`{id}` any name, so an
  item file made or removed passes), and `status.note`. A path or glob counts when it stays inside the
  repository, as the process file's own check takes it (`../docs/TASKS.md` from `root: "plan"` does); an
  item id never names one. A commit that is none of these trips only a lane whose files it touches (the
  overlap rule above). So: a board file a running lane owns changes only through `agentry board add` /
  `agentry board set --apply`, and no commit on main touches a running lane's files. A held lane's owned
  files stay protected for the other lanes; `resume` checks main the same way: an uncommitted edit made while
  a lane was held is undone before it goes on, and a commit touching its files sends it to `exec restart <id>
  --carry`.
- **Trust boundary.** The guard catches a builder that slips into the main checkout; it is not a sandbox. It
  trusts `.agentry/run/` as Agentry's steps wrote it and checks each ledger's claims against git where git can
  say, so a planted ledger naming a SHA excuses nothing. A builder that forges a whole merge record, or edits
  ledgers on purpose, is beyond a guard on a cooperating agent: read the diff when a trip, or its absence,
  looks wrong.
- **A stopped lane.** Its ledger stays as it is; `show` names the reason and the ways on: `agentry lane merge
  <id> --branch agentry/<id>` lands the branch as it is (the owner's call), or `exec restart <id> --carry`
  starts it again with its work.
- **Mid-land.** `start` refuses while a ledger is `merging` with its picks on main: a red gate may still take
  them off, and a lane cut then would carry them. A land that cannot go on is closed on the owner's call:
  `agentry lane merge <id> --resolve landed|rolled-back` (every pick on main, or none; it checks first).
- **The worktree.** A builder leaves no uncommitted or untracked files and at least one commit past base.
- **The tip.** A verdict counts only for the tip it was dispatched on: nobody rebases while a verifier reads.
  A stacked lane's gate counts only on its parent's tip (or main's once the parent landed): `exec gate` refuses
  a due stack, and `restack` runs only with no agent out.
- **Nested worktrees.** A worktree inside the lane's own worktree is listed in `nested` on every step. Name
  it to the owner. A worktree made elsewhere (the conductor's own) is not the lane's.
- **Writers.** `start` refuses when the ledgers in `building` / `fixing` plus worktrees no ledger owns reach
  `lanes.maxWriters` (`.agentry/config.json`, default 3), and names each one. Worktrees the repo keeps
  (`worktrees.keep`) and the host's agent worktrees (`.claude/worktrees/`) without a ledger are not counted.
  A held or parked lane is not a writer (its worktree is owned by its ledger), so another lane may start while
  it waits; a `resume` that sends a builder is refused with the same message while the cap is reached. A
  stacked lane counts as any other: a writer while it builds or fixes; the verified or held lane under it is not.
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
  verifier is next rewrites that waiting brief, whatever the gate's exit. Each dispatch prints `model:` when the contract or `models` in the workflow file names one for its role,
  with its source: a contract bullet `- **Model:** <model>` (builder rounds) or `- **Model (verify):** <model>`
  (verifier rounds) first, then `models` (builder: `build`; verifier: `verify.flagged`, `verify.ui` when a
  designer builds, else `verify.default`), a key by path taking its first `paths` entry that matches an owned
  file: `model: opus (contract)`, `model: opus (models.build.paths[0]: src/main/**)`, `model: sonnet
  (models.build)`. Under `--json`, `model` is the name alone and `modelFrom` its source. `exec start`'s route
  line ends `· ! models.verify.ui is unused: …` for a UI-shaped item that is not flagged when `exec.verify` is
  `flagged` or `none` and `models.verify.flagged` is set (a flagged UI item takes `verify.flagged`).
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
