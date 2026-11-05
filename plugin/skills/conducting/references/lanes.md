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
| `start <id> [--cite A40,A41]` | finds the contract, refuses at `lanes.maxWriters` and a contract whose Steps part has a problem, refuses while another lane's land has its picks on main (`main is mid-land (<id>, since HH:MM): its picks may still roll back → start after it lands, or agentry lane merge <id> --resolve landed\|rolled-back`, exit 2, nothing written), cuts `agentry/<id>` in `.agentry/run/worktrees/<id>`, briefs the builder on the first run of steps (`steps:` lists them); `--cite` adds decisions to every brief by id (a decision whose row names the task is quoted anyway) | `dispatched` |
| `start <id> --on <Y>` | stacks the lane on Y's (see [Stacks](#stacks)), with every `start` check and record (a land mid-pick, `lanes.maxWriters`, the contract, `boardAtStart`): Y resolves like `<id>`, and is `verified` (any next), `held` or at its gate (`next: gate`); cuts `agentry/<id>` from `agentry/<Y>`'s tip, writes `on: "<Y>"` and `base` (Y's tip) to the ledger and prints `stack: on <Y> at <short> (<Y> is <state>); <Y> lands first` | `dispatched` |
| `report <id> [--agent a]` | reads the builder's report, runs the guards, briefs the next round; a run that ends at `→ owner OK` holds the lane instead; a main the guard finds touched holds it for the guard, and on a lane held so it reads the saved report again | `built` when a verifier (or, under `exec.verify`, the gate alone) is next |
| `verdict <id> [--agent a] [--leave N2,N9 [--by owner\|conductor]]` | reads the verifier's report and its tip, briefs the next round. `--leave` records those notes of this report as left as built on the owner's or the conductor's word (`--by`, default `conductor`): `left: [{ label, by, at, round }]` in the ledger, shown by `show`. A left note is never sent back: the recheck brief does not ask for it, `covered` does not need it (so `final: "after-fix"` sends no final for it), and the notes line does not offer it. A label the report does not have refuses, nothing written | the verdict (`FAIL` also `failed`) |
| `gate <id>` | refuses a held lane, running and recording nothing (`<id> is held (<for>): resume it first`; a guard hold: `<id> is held by a guard trip: run its report once main is fixed`). Picks the tier: the `verify` role's while a verifier is out (`expects` is `verdict`), else the `build` role's (`gate.roles`, on the files the branch changed since its base and the item's flag); under `verify: none` a call while a verifier is out exits 2, runs nothing and records nothing: the verifier reads the recorded gate, and the build tier runs after the verdict. Else waits for the gate lock, runs that tier's argv in the worktree, records `{role, tier, command, commit, tree, exit, clean before and after, log}`; a red whose log (or `gate.flakyLogs` files) fails only in `gate.flaky` tests is re-run alone once and both runs are recorded; a gate that queues writes `waiting for gate slot N (held by <who> since HH:MM)` and `slot acquired` to its log, and its output streams there as it runs | none |
| `fix <id> --notes N1,N3` | after `PASS WITH NOTES` (gate or close next): a builder round (resume) on those notes of the latest verifier's report or of the ledger's `openNotes` (each quoted from the report that raised it), then the usual `recheck`. Refused while that notes round is out (`a notes round is out: wait for its report`), whatever the budget, and for a note the verdict left as built (`<label> was left as built (by <by>): leave it, or send it back with fix --owner`) | none |
| `fix <id> --owner "<the change>"` | the owner sends a `verified` lane (next `close` or `merge`) back: one builder round (the last builder resumed, a fresh one with the brief when none was recorded) whose brief quotes `## The owner's change` with its time, then the lane's own route: under an `exec.verify` route that skipped the verifier, the gate on the new tip, then `close`; otherwise a `recheck` by the last verifier, which judges the change as one more note sent back (`owner: PASS\|FAIL <evidence>`; `owner: PASS` with every other note passed is covered, so under `final: "after-fix"` no final follows). The ledger records `ownerFixes: [{ note, at, round }]` and the episode counts them (`owner fixes: N`). Refused: no `--owner` text, `--owner` with `--notes`, a builder already out, a merged lane, any lane that is not verified (or held for the owner at its notes cap, which this answers) | `built` when the round is reported |
| `close <id> [--episode e]` | prints the `episode_write` payload; `--episode` stamps the id it returned. A verified lane whose episode is already stamped (closed again after a rebase or an owner's fix) writes no episode and moves `next` to merge (`close → merge`) | none (`done` comes at merge) |
| `show <id>` | the ledger and the pending dispatch, for a cold resume; on a stopped lane, `stopped: <reason>` and its `ways on:` | none |
| `owns <id> [--set a,b \| --add a,b] [--apply]` | the owned files every brief names, parsed once at `start` and kept in the ledger; `--set … --apply` replaces them and rewrites the brief still waiting for its agent, keeping any section appended after the brief's last template section such as `## The fact` (without `--apply` it only shows the new list; a held lane has no brief waiting: the round after the resume reads the new list). `--add … --apply` appends the paths not owned yet (each read as `start` reads it, normalised: every leading `./` dropped, `//` collapsed, a trailing `/` dropped) and rewrites the brief the same way: for a builder that asked for a file it does not own (a lane in `needs-context` or held for the context); a path an owned entry already covers (the same path, a directory or glob over it, a bare name) changes nothing and says so (`unchanged: already owned: <paths>`), and a verified, merging or merged lane, one held at its notes cap, or one past a passing verdict on its way to the gate (the last verdict passed and no builder round came after it: `<id> is past a passing verdict (PASS) (next gate)`) is refused. `--set` and `--add` normalise each path first and refuse one that then has a leading `/` or a `..` segment (`<path> leaves the repository`), so `.//etc/passwd` is refused; `--set` stores the normalised paths. The hint a context hold prints (`--add <paths> --apply`) offers only such paths that stay in the repository, normalised, and never a word starting with `-` | none |
| `hold <id> --for owner [--evidence <path>] [--agent a]` | a builder's round whose reply is saved waits for the owner's review (`--agent` names the builder out on it, so the resume goes back to that agent) (also on a lane with no steps: the owner looks mid-build); the evidence defaults to that round's report; on a held lane it replaces `for` and the evidence and keeps `since` | none |
| `hold <id> --for later [--note "<why>"]` | parks a lane whose builder was stopped mid-round: no saved reply needed, the worktree kept as it is (uncommitted files allowed); a touched main does not refuse it: the park is recorded and prints `main moved while parked: <reason>; resume re-checks it`. Also parks a `verified` lane (next `close` or `merge`): `hold.when: "verified"`, nothing in the worktree or the rounds changes, `show` prints `held: parked, verified, since <ISO>`, `merge` refuses it while held and drift names no `verified-not-merged`; its `resume` makes it `verified` again with the same next step (no builder, the note in `holds[]`); `--for owner` on it is refused ("hold --for owner is for a builder's round") | none |
| `resume <id> --note "<the OK>" [--redo] [--fresh]` | records the owner's answer with its time (`holds[]`), then dispatches `continue` to the held round's builder, or after the last step the verifier (or the gate); `--redo` builds the same run again and holds at its end; `--fresh` sends a fresh builder the same brief. Main is checked by the guard's own rule (see [Guards](#guards)): a main moved only by commits that touch none of the lane's owned files and none of the files its worktree changed (committed past base or uncommitted) passes, printing `moved: main moved by <n> commits, none touching this lane's files: resuming on base <short>` (`<n>` the commits that rule judged: other lanes' landed picks and record-shaped memory commits (only new `.agentry/memory/<facts|episodes>/<slug>-<ULID>.md` files) are not counted, and with only those nothing is printed; any other commit under `.agentry/memory/` is judged, so it counts); a commit touching them refuses it (`main changed while <id> was held: HEAD moved a → b (<sha> touches <paths>, this lane's files) → agentry lane exec restart <id> --carry`); with no move on main nothing more is printed | `built` when a verifier (or the gate) is next |
| `restack <id> [--main]` | a stacked lane with no agent out (its gate, close or merge next, or held): rebases `agentry/<id>` onto its parent's new tip, or main's once the parent landed (`--main`: onto main whatever the parent's state, the owner's call); writes the branch and the ledger only (see [Stacks](#stacks)). Refused (exit 2, nothing changed) on a lane held by a guard trip (`<id> is held by a guard trip: run its report once main is fixed, then restack`) on a parked verified lane (`<id> is parked verified: resume it, then restack`) and on a lane held at its notes cap (`<id> is held at its notes cap: resume or fix --owner, then restack`), each before any rebase, the branch left where it was; a parent's land leaves such a child as it is and names it with the same line | none |
| `restart <id> [--carry]` | a lane that is not merged, with no agent out (`a builder is out: hold it first`; a verifier out, a gate of it queued or running, a land of it, a lane stacked on an unmerged parent and a lane with an open stacked child (`<child> is stacked on <id>: restack or close it first`) are refused too), started again: refuses while another lane's land has its picks on main (`start`'s check), at `lanes.maxWriters` (the lane itself not counted), when its worktree holds ignored files outside `cleanup.disposable` (and the defaults), naming them (an empty directory, or one holding only empty ones, is no file: it never counts, and the removal takes it), and when the board write `dispatched` would refuse (its row gone): every refusal comes before any write. Past the archive nothing is refused: a failure is a stop (exit 1) that clears the old lane's board verdict (or names the `board set` call that clears it, last among the steps), naming the archive, the branch that holds the old work and the diff's path, then the steps back by hand (`→ fix that, then: …`: the delete of a new branch left beside the kept one, or, for a stop before the rename (the old work still on `agentry/<id>`), `git branch -m agentry/<id> agentry/<id>.<n>` first; `exec start`, and for `--carry` the `git cherry-pick <sha>…` of the commits it would pick when there are any, and the `git apply --3way <diff>` when a diff was saved). Saves the worktree's uncommitted diff (untracked files too) to `runs/<id>.<n>/restart/uncommitted.diff`, archives the ledger and run dir as `ledger/<id>.<n>.json` and `runs/<id>.<n>/` (`n` one past the highest archive or kept branch, so an older one is never overwritten; a hold's `holds[]` stays in it), removes the worktree, keeps the branch as `agentry/<id>.<n>` and cuts a fresh `agentry/<id>` from main with every `start` record (`boardAtStart` from the spec loaded now, `mainAtStart`, `dispatched`); a verdict on the board (`lifecycle.write.verdict`) is the old lane's, so it is cleared through `board set` (recorded), or, when that fails, a `!` warning says the verdict is from the old lane and names the `board set` call that clears it; prints `restarted: archived as <id>.<n>…`. Without `--carry` the new lane starts clean and the old branch stays. A `--carry` of a lane whose last verdict passed with nothing after it but its gate or close (`next` gate, close or merge, or parked verified), on the very tip it settled on (`gateTip` / `closedTip`) and with no uncommitted work, that carries without a conflict goes on as a rebase does, never a build round: the range-diff of the old `base..tip` against the new one is `logs/range-diff-1.txt`, the new ledger's first `rebases[]` entry (`carried: true`), printed as `rangeDiff:`; the old lane's counted verdicts are the new ledger's first rounds, each marked `carried: "<id>.<n>"` (the archive; a round an earlier restart carried keeps its first marker, the archive that holds its files) with its files read in the archive, so the land's flagged-item check and the episode count them, while the three-verdict stop counts only the new lane's own verdicts and a recheck that would resume a carried round's verifier sends a fresh one; a changed carry under `exec.rebase: "recheck"` goes to `resolve` (its brief without `## Carried work`), any other to the gate on the new tip (or `close` with no gate); the board's verdict stands (it is not cleared) and `built` is written after `dispatched`. A carry that conflicts, a last verdict of `FAIL`, no verdict, or work after the verdict keeps the build round below. With `--carry` it cherry-picks the old branch's commits that are not on main (`git rev-list --reverse --no-merges <main>..<tip>` at the listed tip, never `<base>..<tip>`: a branch rebased in-branch onto a newer main carries only its own commits; one whose patch main has already, `-` in `git cherry`, is skipped and listed as `skipped: <n> already on <main>: <sha> <subject>, …` and in `carried.skipped`; a branch with none picks nothing; the brief's count is the picks), then applies the saved diff (`git apply --3way`), and the first build brief gets `## Carried work`: `A previous builder's work is in the tree (<n> commits, <m> files uncommitted). Its last report is <path>: read it first.` (the report in the archive), and when files were carried, that they are applied staged (`git apply --3way` stages them), or, when a pick stopped first, that the diff is still to apply (the step named once: in the stop when it names it); once all of it is carried the old branch goes, after the new ledger is written. A conflict stops the carry (exit 1): main untouched, the conflict left in the new worktree for the builder (`conflict: <sha> <subject> conflicts in <files>: resolve it, git cherry-pick --continue, then git apply --3way <diff> in <worktree>`, or `the uncommitted diff conflicts in <files>`), named in the brief too, the old branch kept as `agentry/<id>.<n>`. A `--carry` of a branch whose merge base with main is no commit of main's first-parent history refuses before anything is written: `<b> is not based on <main>: rebase it onto <main> or land it with lane merge --branch`. The range-diff of a verified carry starts at that merge base. The ledger records `restarted: { from, ledger, runs, branch, at }` and `carried: { commits, skipped?, files, report, conflict? }` | `dispatched` (then `built` for a verified carry, whichever step it goes to) |
| `adopt <id> --branch <b>` | work built outside exec (an agent's worktree, a hand branch) becomes the lane, with `start`'s checks and records (the contract found, no ledger for the id, not mid-land, `lanes.maxWriters` with `<b>`'s worktree not counted, the board write `dispatched` tried first). Refuses, one line and nothing written (no ledger, run dir, worktree or board write): `<b> does not exist` (also for a revision such as `<b>~0` or `<b>@{0}`, `HEAD`, `refs/heads/<b>` or another case of a name, `agentry/t2` for `agentry/T2`: `<b>` must be a branch's own name exactly as `git for-each-ref` lists it, and its tip is read from that line, never by name; a value holding a control character is shown JSON-escaped); `<b> has a case twin <other>: rename one first` (another listed branch differs only in case, whatever `core.ignorecase` says: one could be read or deleted for the other); `<path> is on <spelling>, which no branch is named: check it out by its exact name` (the worktree of `<b>` has HEAD on another case of it, as `git checkout WORKTREE-AGENT-X` writes); `<b>` is the main branch; "<b> is <id>'s lane branch: use exec restart <id> --carry" (a branch a ledger tracks; a ledgerless `agentry/` branch is adopted like any other, except `agentry/<id>` for its own id, which is what the cut makes: "<b> is the branch a lane for <id> cuts: land it as it is with lane merge <id> --branch <b>"); `<b> is already adopted by <id>` (an open lane adopted it); the worktree of `<b>` is mid-rebase, mid-merge or mid-cherry-pick; `nothing to adopt: use exec start` when `<b>` has no commits past main and its worktree (if any) is clean. Cuts a fresh `agentry/<id>` from main, cherry-picks `main..<b>`'s own commits onto it (`git rev-list --no-merges`: a branch that merged main in holds main's commits already; the merges are left out, recorded as `adopted.merges` and named in the brief, which says to compare the lane with `<b>`'s tip for anything a merge resolved by hand) and, when `<b>` is checked out in a worktree, applies that worktree's uncommitted diff (untracked files too; saved to `runs/<id>/adopt/uncommitted.diff`), as `restart --carry` does (an error inside the carry that is not a conflict takes the new lane down again, its worktree, branch and the run files it wrote (`runs/` too when the adopt made it), and stops with exit 1: `the adopt stopped: …`, saying the new lane was taken down only when its worktree and branch both went, else naming what is left (`left: …`, each with its remove command)): a conflict stops the carry (exit 1, its next step named: `resolve it, git cherry-pick --continue, then git apply --3way <diff>`) with the ledger written whole and the lane `building` (next `build`, never `held`), the conflict left in the new worktree for the builder and named in `conflict:`, in the ledger's `adopted.conflict` and in the brief. `<b>` and its worktree are never moved or changed; `cleanup:` prints how to remove them once the lane has landed (`git worktree remove <path>; git update-ref -d refs/heads/<b> <tip>`: git refuses it if the branch has moved, and it never takes a case twin along as `git branch -D` can). Every printed command shell-quotes a path or branch that needs it. Adopted commits that change files outside the contract's owns are `!` warnings naming each commit, then the `agentry lane exec owns <id> --add <paths> --apply` line: never a refusal. The ledger records `adopted: { branch, tip, commits: [{ sha, subject }], merges?, worktree, files, applied?, diff?, conflict?, at }`; the next step is build, and its first brief gets `## Adopted work`: the commits as `<sha> <subject>`, already on the lane: check them against the contract, fix what the owner asked, do not redo them. A worktree a lane adopted no longer counts as a writer, nor shows as drift | `dispatched` |
| `cut <id> --decision <D> [--keep <paths>] [--message "<subject>"] [--apply]` | retires a lane on the owner's call, recorded as a decision the board holds (`<D>` by its id as the board writes it, any case). Previews by default: what lands, the gate tier, the board write, the worktree and branch, `preview: nothing written`. With `--apply` and `--keep` (comma-separated files or folders the branch changes against main), the kept files' content at the lane's tip lands as one commit on main (`--message`, default `chore(<scope>): keep <n> files from <id>`, the scope the first folder every kept file shares, else the id; checked against `commits` and for AI attribution) through the land's own steps: main's row and the carry of exec's writes, the pick, the merge role's gate tier on those files, and on red the rollback: main back at its HEAD, the carry back, the lane as it was (exit 1). Once gated the land record leaves the ledger, so the other lanes' guards judge the commit as any commit on main (only an overlap with their owned or changed files trips, see [Guards](#guards)) and drift never reads it as a land. Then, as the land's record and commit steps do, exec's carried writes and the owner's recorded board writes go back on the board with `cut`, and one board commit holds them (`chore(board): cut <id> (<D>)`, through the repo's hooks; `--message` names only the kept commit), so main is clean and the next `lane merge` lands as usual; the owner's `guard.allow` edits go back after it. A board commit that refuses takes the board back, the kept commit off main and the lane back as it was (exit 1). It records `cut: { decision, kept, commit, boardCommit, at, uncommitted? }` and the episode payload (`episode.payload`, its outcome `cut on <D>: kept <n> file(s) (…)`; the step prints it with `afterwards: episode_write …, then exec close <id> --episode <its id>`, and session close lists it as pending until stamped) and closes the ledger (`state: "closed"`: never held, idle or listed by `session start` again), saves the worktree's uncommitted diff to `runs/<id>/cut/uncommitted.diff`, removes the worktree and keeps the branch as `agentry/<id>.cut` (made at its listed tip, the old ref deleted at that tip). A cut killed mid-land (state `merging`, `merge.cut`) is rolled back by the next `exec cut <id> --decision <D> --apply`: the gate it left running stopped, main reset to where the cut began (`git reset --keep`) when its commits since are only the cut's own, known by identity and never by subject (the kept commit the ledger recorded, or one on that start whose tree is the planned kept commit's; the board commit whose parent and blobs were recorded before it was made), the board files it was writing back to HEAD only when every difference is its own (a carried cell, a recorded write's cell, its `cut` word; anything else refuses: `<file> has writes made after the cut stopped: commit or set them aside, then run exec cut again`), the set-aside writes back, the lane's state before the cut restored and `merge` cleared; it stops (exit 1) with `rolled back the stuck cut: … → run exec cut again`, and refuses, nothing changed, when main holds anyone else's commit or change since. Every stop of a cut names this rerun as its way out, never `lane merge --resolve`. Without `--keep` none of the branch lands on main: the board commit is the cut's only commit (none with the lifecycle off). Refused, nothing written: an agent out (`a builder is out: hold it first`, a verifier out, a gate queued or running), no `--decision` or one the board does not hold, a `--keep` path the branch does not change, kept files main already has as the tip does, a main that is not clean but for exec's writes, `guard.allow` edits and recorded board writes, the lane or another lane mid-land, a merged or closed lane, no gate (with `--keep`), a worktree holding ignored files outside `cleanup.disposable`, `agentry/<id>.cut` already there, and an unset `lifecycle.on.cut` (`exec.kinds.<kind>.on.cut` for a debt kind), naming the key to add | `cut` |

Exit 0: `next` is printed. Exit 1: the lane stopped (or, for `gate`, the gate is red; for `restack`, git
stopped the rebase and it was aborted). Exit 2: usage or a
refusal, nothing changed (an out-of-order step, a missing report file, a dirty worktree at the gate, a run from
inside a worktree instead of the main checkout).

**Work built outside exec.** An agent worktree no ledger knows, not on main, is a drift row with four ways
on: `unlisted-worktree <branch> →` land: `lane merge <id> --branch <b>` · continue: `lane exec adopt <id> --branch <b>`
· file: `lane spike <b> --for <id>` or `lane spike <b> --keep "<why>"` · remove: `git worktree remove <path>` (`<id>`
when the branch or directory name holds a board id, the path relative to the main checkout, a path or branch
that needs it shell-quoted). An orphan `agentry/<id>` worktree (no ledger) is the branch a lane for `<id>` would
cut, so its row offers land, file and remove, never continue. A worktree whose HEAD is a spelling no branch is named (another case of its branch) offers only remove, saying why: land, adopt and spike refuse that spelling until it is checked out by its exact name. `agentry lane spike <branch|path> --for <id>` files
it as work meant for that item: drift shows one `spike-for <id>` row (`land: … · continue: …`) until a ledger
for `<id>` adopts or merges that branch. `agentry lane spike <branch|path> --keep "<why>"` keeps it on purpose:
shown on the Kept row with `worktrees.keep`, never drift. `--forget` drops the entry; with no flag it lists them,
a branch gone since shown as `gone` (and dropped from drift). A `spikes.json` that cannot be read is one
`spikes-unreadable` drift row naming the file, never read as empty. The list is `.agentry/run/spikes.json` in the main
checkout (`{ branch, path, for?, keep?, at }`, written whole): local run state, not the board, so it writes at
once with no `--apply`. It refuses (exit 2, nothing written) an unknown branch or path (a revision such as `<b>~0`, or another case of its name, is neither), a branch with a case twin, a worktree on a spelling no branch is named, the main checkout, a
branch a ledger tracks (its own lane's, or one an open lane adopted; a ledgerless `agentry/` worktree is filed
like any other), an id the board does not hold, and `--for` with `--keep`.

**Owner calls.** A call the owner makes on a lane or a spike (keep this, drop that, ship it as is) is recorded
where it was made, so no call lives only in a chat: `agentry lane note <id> --owner "<call>"` appends
`{ n, at, text, recorded: null }` to the `calls` of `<id>`'s open ledger, else of the spike filed `--for <id>`
(in `spikes.json`; filing it again for the same item keeps them). One line of plain text per call: a line or
paragraph break of any kind, or a control character, is refused. `agentry lane note <id>` lists them as
`n · at · recorded|not written down · text`, and
`agentry lane note <id> --recorded <n,n|all> --where "<file or section>"` marks them written down
(`recorded: { at, where }`) once they are in the decisions or sprint file. Refused, nothing written (exit 2):
an item with no lane and no spike (the refusal names `lane spike <branch> --for <id>` and `lane exec adopt`; for a
merged or closed lane it says the lane's state),
two spikes filed for it (which one a call is about is not known), an empty or multi-line call, a call number
no holder has, and a ledger or `spikes.json` that cannot be read (named, never written over).
`exec adopt <id> --branch <b>` moves the calls of the spike filed for `<id>` on `<b>` into the new ledger,
numbering kept, and the spike keeps none; `exec restart` keeps them in the new ledger. While a spike holds a call
not written down, `lane spike <b> --forget` and a re-file `--keep` or for another item refuse, nothing
written: `<b> has <k> open owner call(s) for <id>: lane note <id> --recorded <n|all> first`. `exec close`'s episode says `owner calls: <k> (<j> written down)`;
`session close` lists the ones not written down, merged and closed lanes included, until they are marked.

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
| build, fix | `NEEDS_CONTEXT` | `needs-context` (resume, with the fact) once per step: the run of `steps` the builder is on, so the owner's resume past a step hold starts a fresh one (a lane with no steps is one step); asked again in the step, held for the context (`hold: { for: "context", reason: <the report's first line>, report, since }`, the report read, nothing in the worktree changed): `held: the builder needs more context again → supply it: agentry lane exec resume <id> --note "<the fact>"` |
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
| verified `PASS WITH NOTES` | notes rounds used = `exec.noteRounds` (0 under `lean`) | the lane goes on to `gate` / `close`; the notes are kept as `openNotes`; `fix --notes` exits 2 naming `exec.noteRounds` and the owner's way past it (`… → raise exec.noteRounds, or send it back on your word: agentry lane exec fix <id> --owner "<the change>"`) |
| verify, recheck, final | `PASS` / `PASS WITH NOTES` with notes left open, notes rounds used = `exec.noteRounds`, the item flagged | held for the owner (`hold: { for: "owner", when: "verdict", reason: "notes cap reached with open notes on a flagged item", tip }`), not `gate` / `close`: `exec resume <id> --note "<the OK>"` closes it as is (the gate on the verdict's tip, or `close` when green), `exec fix <id> --owner "<the change>"` sends it back; `hold --for later`, `owns --add` and `restack` are refused while it holds, and `fix --notes` too unless `exec.noteRounds` was raised since (read live: one more notes round goes, ending the hold; else the refusal says `this flagged item holds for you at the cap: resume to close as is, or fix --owner`) |
| verified (next `close` or `merge`) | `agentry lane exec rebase <id>` (a land conflict names it) | `rebase` (resume the last builder): rebase `agentry/<id>` onto main, change nothing else. When its report moves the guard's start (`mainAtStart.head`), a path clean on main whose content the commits from the old start to the new one changed (its edit committed) drops its start entry (`files`, `porcelain`); one still dirty, or clean with those commits leaving it as it was (its edit discarded), keeps it, so it still trips. Once a rebase moved the start, a path clean on main whose start entry is the lane's own board write (`boardWrites[].to`, the board mid-write at start) is never `(back to HEAD)`; before any rebase, a discard of it trips as any other |
| restarted with `--carry`, the old lane's last verdict a pass on the tip carried, no uncommitted work, no conflict | `agentry lane exec restart <id> --carry` | as a rebase report: `resolve` (a fresh verifier on the carry's range-diff) when the range-diff changed under `exec.rebase: "recheck"`, else `gate` on the new tip, or `close` with no gate |
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
| held for the context | `agentry lane exec resume <id> --note "<the fact>"` | `needs-context` (resume the builder) with the note under `## The fact` at the end of its brief, as the first re-dispatch; a context hold never sends a builder by itself, `hold` on it is refused (`<id> is held for more context: resume it with --note "<the fact>"`), and a guard trip on the report that asks again is a guard hold first. Its reason is the report's summary, cut at a word and outside backticks and parentheses. The `held:` line also names `exec restart <id> --carry`, the other way on; a held lane does not land (`merge` lands only a verified one) |
| held | a report, verdict, notes fix or gate | refused: the lane expects a resume (`exec gate` runs nothing and says `<id> is held (<for>): resume it first`, or for a guard hold `<id> is held by a guard trip: run its report once main is fixed`) |
| a stacked lane at its gate, close or merge | `agentry lane exec restack <id>`, resolution `none`, after a verdict (or a `builtTip`) | `gate` (verifying) on the new tip: the verdict stands for the same commits; a gate on the old tip no longer counts |
| a stacked lane at its gate, close or merge | `agentry lane exec restack <id>`, resolution `by hand`, after a verdict | `resolve`: the resolution recheck, a fresh verifier on the restack's range-diff |
| a stacked lane held, no verdict yet | `agentry lane exec restack <id>` | no change: recorded; the one verifier after the build reads it all |

A run is the steps from a to g, g the first step from a with an owner gate, else the last step: the steps
with no gate between them are built in one round. A lane without steps is one run of the whole contract and
behaves as it always has; so does an older ledger. The owner's answers spend no budget: a hold waits, and the
resume picks up where the lane was. One fresh verifier reads the whole contract after the last step.

The route is fixed at `start`: the ledger keeps `route: { verify, flagged, preset, noteRounds, final, rebase }`
(the workflow file's `exec` keys as its preset resolves them), so an edit of the workflow file changes no
running lane's verify, final or rebase, and a ledger without these keys runs on the `standard` values. The
notes-round cap is the one key read live: `fix --notes` and each verdict read the workflow file's
`exec.noteRounds` (or its preset's) as it is at the call, so raising it lets a lane at its cap send another
notes round. `exec start` and `show` print the `workflow:` line, `show` also `route fixed at start: …` (its
notes part `notes 2 (live)`), `board explain` marks the `exec.noteRounds` row `(live)`, and `route: all (fixed at start; workflow.json
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
one `needs-context` round per step, and a guard fix (resent or not) that trips a guard again stops. Every lane ends in
`close` or `stop`, or waits in a hold (the owner's, a park, the context the owner supplies, or the guard's until main is fixed). With no `gate` in the workflow file, a `PASS` closes on the verdict and the output says so.

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
Steps listed inline, with `1. ` after the label on its own line (`- **Steps:** 1. Build it 2. Ship it`), are
never parsed: they are a steps problem whose words end with a rewrite, one `<n>. <text>` per line, gates and
markers kept as written. The rewrite is a best-effort hint, cut at the next number in order
(` 2. `, then ` 3. `, …) outside code spans, from the label's paragraph (to a blank line or a list item at or
left of the label's indent); check it before pasting it in. A `Steps` heading followed by `1. a 2. b` is one
step, as before.
An item ending `→ owner OK` or `-> owner OK` (any case, optional period) has an owner gate. An item ending
`(model: <m>, agent: <designer|implementer>)` (either key, before or after the gate, any case, read in lower
case; each value one word, the keys split by a comma) names its run's builder model and agent: the first step
of the run with each wins over the contract's `- **Model:**` / `- **Agent:**` bullets, which win over the
workflow file's `models.build` and the owned paths; the `model:` and `dispatch:` lines name the step
(`opus (step 1)`, `"from": "step 1"`). Under the Acceptance
label or heading, a list item that starts `Step N:` is step N's (the tag cut); every other item is the whole
contract's. `start` refuses a Steps part with a problem, named exactly: `steps must be numbered 1 to N with no
gap (found 1, 3)`, `the Steps part has no numbered items, one per line`, `the Steps part lists its steps inline:
put each step on its own line` (then the rewrite, one step per line), `step 1's marker names model
"opus agent: designer": a marker value is one word, and its keys are split by a comma`, `step 2 names agent
verifier; a step's agent is designer or implementer`, `steps 1 and 3 are built in one round but name different
models (opus, sonnet): put an owner gate between them or name one model`, `acceptance names step 3; the
contract has 2 steps`. `board check` reports the same problem first, as a `ready-has-contract` finding
(`contract <id>: …`), for an open item in an active parent. `agentry board contract <id>` prints `steps` (and
`stepsProblem`) with the block.

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

**A new step starts a fresh builder.** The resume that approves a step (`after` hold, no `--redo`) dispatches
the next step's first round as `mode: fresh`: the brief names the last report of the step before, and the
model and agent follow that step's `(model:, agent:)` marker. `--same` keeps the old builder for the new step
when the owner asks for it. Every other builder round stays on the builder it belongs to: a `--redo`, a fix,
a needs-context round and the carry-on of a hold during a round resume it. A one-step lane builds as before.

**Only a DONE moves a step.** A builder's DONE (or DONE_WITH_CONCERNS) on a step is what holds the lane after
it or sends the work to the verifier. A NEEDS_CONTEXT round, a hold, a void verdict or a resumed context hold
never moves it: a lane held after step 1 of 2 with a needs-context round in between still reads `after step 1
of 2` and resumes into step 2, never to the verifier or close.

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
  allows one such round per step; asked again in the step it holds for the context: ask the owner and run the
  `run:` line with the fact as `--note` (its brief then carries it, so no `todo`). When the report names paths
  outside owns (a `needs: <path>` line, or a backticked path the lane does not own, in its first 20 lines; a
  backticked word with no `/` only when it is a file in the worktree, and never a path leaving the repository), the
  `todo` or `held:` line adds `or let it touch them: agentry lane exec owns <id> --add <paths> --apply, then
  resume`.
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
  touching a file only another running lane owns trips that lane, not this one. When the lane's branch holds main past
  the start (the builder rebased or merged main in-branch, field 102), the start follows it: the merge base of
  main's HEAD and the branch's listed tip becomes `mainAtStart.head` (its snapshot moved as a rebase's is),
  recorded in `startMoves[]` as `{ from, to, why: "branch holds main", at }`, but only when every main commit
  from the old start to there passes this rule judged against the lane's owned files alone; one touching an
  owned file (a wrong-cwd commit the branch was then rebased onto) keeps the start, so it trips. Commits after
  the merge base are judged as any. "The files its worktree changed" are counted from that merge base once the
  branch holds main past its base, so main's own changes are never this lane's files, and a start moved this way
  counts as moved for the board's mid-write entry, as a rebase's does. An overlapping commit trips
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
  (`worktrees.keep`) and the host's agent worktrees (`.claude/worktrees/`) without a ledger are not counted,
  nor a worktree a lane adopted (`exec adopt`).
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
