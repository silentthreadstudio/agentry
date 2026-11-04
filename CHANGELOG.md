# Changelog

All notable changes to Agentry are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Pre-1.0, the version
scheme is pragmatic: patch releases carry fixes, docs, and small additions.

## [Unreleased]

### Added
- **`lane exec adopt <id> --branch <b>`** — work built outside exec (an agent's worktree, a hand branch)
  becomes the lane: `start`'s checks and board write, a fresh `agentry/<id>` cut from main, `main..<b>`'s own
  commits picked onto it (its merge commits left out and named in the brief) and the uncommitted diff of
  `<b>`'s worktree applied, as `restart --carry` does. `<b>` and its worktree are only read, and `cleanup:`
  prints how to remove them once the lane has landed. The first brief lists the adopted commits; commits
  outside the contract's owns are a warning with the `lane exec owns <id> --add <paths> --apply` line. A
  conflict leaves the lane building with the conflict in its worktree for the builder; any other error in
  the carry takes the new lane down again and names what it could not remove. `<b>` must be a branch's own
  name exactly as git lists it: a revision (`<b>~0`), another case of a name, a branch with a case twin, the
  main branch and a branch a ledger tracks are refused, with nothing written.
- **`lane spike` and ways on for unlisted worktrees** — `agentry lane spike <branch|path> --for <id>` files an
  agent worktree no ledger knows as work meant for that item, `--keep "<why>"` keeps it on purpose (shown as
  kept, never drift) and `--forget` drops it; with no flag it lists them, a branch gone since marked `gone`.
  The list is local run state (`.agentry/run/spikes.json`), written at once. Drift now offers an unlisted
  agent worktree its ways on, each with its command: land (`lane merge <id> --branch <b>`), continue (`lane
  exec adopt <id> --branch <b>`), file (`lane spike`) or remove (`git worktree remove`), never
  `/agentry:exec`. A spike filed for an item is one `spike-for <id>` row until a lane takes its branch, an
  adopted branch is no drift, and an unreadable `spikes.json` is a `spikes-unreadable` row.
- **`lane note`** — `agentry lane note <id> --owner "<call>"` records a call the owner made on a lane, or on
  the spike filed for the item, one line each; with no flag it lists them, and `--recorded <n,n|all> --where
  "<file or section>"` marks them written down. `exec adopt` moves a spike's calls into the lane and
  `restart` keeps them; a spike holding calls not written down refuses `--forget` and a re-file that changes
  its item. `exec close`'s episode counts them, and `lane session close` lists the ones not written down
  (`calls`, `callLines`), merged lanes included, until they are marked; `/agentry:close` writes them where
  the repo keeps decisions and marks them.
- **`board next-id <kind> --family <prefix>`** — the next free id among every board id in that prefix family,
  whatever kind holds it (`ART-19` after `ART-18`, `<prefix>-1` when there is none), so a kind whose ids are
  chosen by hand no longer takes one another kind already uses. A family ending in a digit needs a separator
  (`R1` does not read `R19`). The chosen-by-hand refusal names it, and `/agentry:new` proposes it when the
  owner names a prefix.
- **`board commits --learn [--min <n>]`** — reads the last 500 first-parent commits of the default branch and
  prints the `commits` rules they keep: `subjectPattern` with the Conventional Commits types and each other
  type used at least `--min` times (default 3), `subjectMax`, and whether every subject has a scope. It writes
  nothing, and with no history it says why and prints the standard set. `/agentry:init` proposes its rules
  instead of a pattern written from the spec alone.
- **Commit rules in the land and the rebase** — when a commit's subject fails `commits.subjectPattern` on a
  type main already uses, the `commits` row of `lane merge` says how often main uses it and prints the
  pattern widened to take it. `lane exec rebase` lists each commit the land would refuse under `## Reword`
  in the rebase brief (`reword <sha> "<subject>": <why>`), the one rewording that brief allows. A branch
  whose merge commit brings in another open lane's branch names that lane: land it first (`next` is its
  land), then `lane exec rebase`.
- **Model and agent from the contract and its steps** — a step ending `(model: <m>, agent:
  <designer|implementer>)` names its run's builder model and agent, ahead of the contract's `- **Model:**`
  bullet and the new `- **Agent:** <designer|implementer>` bullet, which win over `models.build` and the owned
  paths. The `model:` and `dispatch:` lines name the source (`opus (step 1)`, `"from": "contract"`); an
  unmarked dispatch prints as before. Steps of one run that name two models or agents are a steps problem.
  `exec start` hints when the contract's prose names a model that no bullet or marker sets.
- **The note's age and idle lanes asked once** — `lane session start` labels the note with its age once it is
  12 h old (`note (3d old): …`) and calls it stale when the Now it was first read under has moved on (`note:
  stale, written 3d ago when the Now was S1, now S2 → rewrite or clear .agentry/NOTE.md`); `/agentry:close`
  then asks the owner to rewrite or clear it. An idle lane is put to the owner once per quiet spell (`ask
  the owner once: park T6?`), and later starts print one quiet `idle: T6 (asked 12:05; …)` line until its
  last change moves; a lane counts as asked only when the question fits in the 40 lines. Both records are
  local (`.agentry/run/note-seen.json`, `idle-asked.json`). In `--json`, the note carries `writtenAt`, `now`,
  `old` and `stale` as `{ why: "now-changed" | "ids-done", … }` (it was the list of ids), and each `idle[]`
  lane `asked`.
- **`agentry run` and named locks** — `agentry run --limit <dur> [--lock <name>] [--wait <dur>] -- <cmd>`
  runs a command (no shell) in its own process group and stops the whole group at the limit (SIGTERM, then
  SIGKILL 5 s later; exit 124), since macOS ships no `timeout`. `locks` in `workflow.json` (`{ "editor": 1 }`)
  declares locks shared by every worktree: `--lock` waits for a slot and holds it while the command's group
  lives (exit 75 when it stays busy for `--wait`, 10 minutes by default). `agentry lock take <name>` /
  `drop <name>` hold one across tool calls, for a shared editor driven through MCP, until `--ttl` (30 minutes)
  or the session ends; `lock show` lists the holders and `lock drop --orphan` frees a slot only a leftover
  process group holds. A command that is a `gate.tiers` argv takes the gate slot the same way. Build and verify
  briefs name `agentry run --limit` in their time-limit rule, and the lock to take when `locks` is declared.
- **`lane merge <id> --resolve landed|rolled-back`** — closes a land left in `merging` that cannot go on, on
  the owner's call, after checking main. `landed` needs every recorded pick on main: the ledger is merged and
  the board's done row and handoff line are the owner's; any lane stacked on it is named with its
  `restack --main` step. `rolled-back` needs no pick on main (found by sha, by author, date and message, or by
  patch; a reverted pick still counts as on main): the lane is verified again. Both refuse while git is
  mid-pick, while the ledger still holds what the land set aside, or when git cannot tell, and touch neither
  main nor the board. `lane exec start` refuses while a land's picks are on main (a red gate may still take
  them off) and names it.
- **`lane exec restart <id> [--carry]`** — a lane that is not merged and has no agent out is archived as
  `<id>.<n>` (its branch kept as `agentry/<id>.<n>` unless `--carry` took all of it) and started again from
  main, the old verdict cleared on the board. With `--carry` its commits and uncommitted diff come along, and the new brief names what was
  carried and the old report; a conflict is left in the new worktree for the builder (exit 1). Every refusal
  (a builder out, a gate queued, a lane stacked on it, ignored files in the worktree) comes before anything
  is written. A stopped lane's `show` names it and the other way on, `lane merge <id> --branch agentry/<id>`.
- **Parking a verified lane and sending it back** — `lane exec hold <id> --for later` also parks a lane that
  is verified (merge refuses it while held; `resume` makes it verified again), and `lane exec fix <id> --owner
  "<the change>"` sends a verified lane back for one builder round on the owner's words, then to the usual
  recheck, which judges the change as one more note. The episode counts the owner's fixes. `lane session start`
  prints a parked lane's note, its evidence and the step that resumes it; a park on a lane whose main was
  touched is recorded and says `main moved while parked`.
- **Holds instead of stops** — a builder report that finds main touched holds the lane for the guard (its
  report saved) instead of stopping it: fix main, then `lane exec report <id>` again goes on as the first
  would have, and `lane session start` shows the hold with its reason and that step. A second `NEEDS_CONTEXT`
  in the same step holds the lane for the owner's fact: `lane exec resume <id> --note "<the fact>"`, or
  `lane exec owns <id> --add <paths> --apply` for the files the report names outside the contract (the held
  line prints it), or `restart --carry`. A flagged item whose verdict leaves notes open at the notes cap holds
  for the owner: `resume` closes it as is, `fix --owner` sends it back. The cap is read live from the
  workflow file, so a raised `exec.noteRounds` lets one more notes round go.
- **Decision drafts take a why** — a draft may carry a `why`, and `board draft apply <n> --answer "…" --why
  "…"` writes the owner's correction and keeps it on the draft's line with the text it replaced. The
  `drafts.decision.map` placeholders are `{answer}`, `{why}` (the draft's question when it has no why),
  `{question}` and `{unpicked}`; with no `drafts.decision` in the workflow file, `apply` fills the decision
  kind's own `decision`, `why` and `rejected` fields and says so.
- **`lane sweep` frees what killed processes left** — temp files whose writer is gone
  (`<file>.agentry-<pid>.tmp`, and the older temp names in the ledger, drafts and gate-locks folders), gate and
  lock slots whose holder and riders are gone (each group a run left running is stopped first), and write locks
  whose owner is gone; `--json` lists them as `temps`, `slots` and `writeLocks`. The preview lists them and
  removes nothing, and each is judged again at `--apply`. `lane session start` counts them in a
  `! stale: <n> lock slot(s), <n> temp file(s) → agentry lane sweep --apply` row, and its `lanes:` line lists
  open lanes only, then `· <n> merged today`.
- **The running build in `--version`** — `agentry --version` and the footer of every `--help` print what the
  checkout is past its version bump and the short HEAD, `0.3.0-dev.7+141 (22abc92)`, with ` dirty` when the
  plugin tree has uncommitted changes, so a session started before a change can tell; `(version unknown)` when
  `plugin.json` cannot be read.
- **Stacked lanes** — `lane exec start <id> --on <parent>` cuts a lane from another lane that is verified,
  held or at its gate (a chain too), so serial work no longer waits for a land; its `base` is the parent's
  tip, so the briefs, the commit count and the gate tier read only its own commits. Each step prints
  `stack:` with what is due when the parent moves, lands or stops, and `exec gate` refuses until
  `lane exec restack <id> [--main]` rebases the branch onto the parent's new tip or main: only with no agent
  out, never on a dirty worktree or under the lane's gate, with the repo's rebase stash, squash and
  ref-update config off; a conflict is aborted with the branch and ledger as they were. A clean restack gets
  the gate on the new tip; one resolved by hand gets the resolution recheck. `lane merge` lands a stacked
  lane only after its parent and its restack onto main; the parent's land restacks each child at rest
  itself and names the ones it left. `exec show`, `lane session start` and the episode name the stack.
- **Session checks from the repo's own session skill** — `extensions` takes `start` and `close` beside
  `merge`, each `{ "checks": [<skill>, …] }` (one skill may be named in both; `extensions: {}` is refused).
  `/agentry:start` and `/agentry:close` run each named skill (its `## Start` / `## Close` section, or the
  whole skill) and record the outcome with `lane session <start|close> --check <skill>=pass|fail
  [--note <t>]`, appended to `.agentry/run/process/session-checks.jsonl` (local, never committed).
  `lane session start` lists the checks to run and how the last close's went; start and close `--json` carry
  `checks`; the handoff names each failed or pending close check. `board explain` shows the
  `extensions.start.checks` and `extensions.close.checks` rows. `/agentry:init` offers to absorb a session
  skill the way it absorbs the merge skill, showing its shrunk text. `board instructions-lint` is no longer a
  subcommand of its own; `board instructions --lint` is unchanged.
- **Competing-line lint and a local trigger block** — `board instructions --lint` reads `AGENTS.md`,
  `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and the conductor prompt and points at lines that
  compete with the Agentry block (every task through `/agentry:go`, a session routine, landing by hand, the
  gate run by hand), each with the replacement to offer; it only suggests and never writes (exit 1 with
  findings). `board instructions --target local` puts the block in `CLAUDE.local.md` instead of `AGENTS.md`,
  for a repo that is public: no import is added, a block already in the other file moves (removed there and
  written here in one all-or-nothing write), and a note says when git tracks or does not ignore the file.
  A block in both files is refused. `board explain` reads the trigger block from either file. `/agentry:init`
  asks where the block should live and offers each lint replacement one at a time.
- **Workflow presets for the exec lane** — `exec.preset` (`lean`, `standard` by default, `strict`) sets
  `exec.verify`, `exec.noteRounds` (0 / 1 / 3 notes-fix rounds), `exec.final` (`never`, `after-fix`,
  `always`), `exec.rebase` (`gate`, `recheck`) and the `gate.roles` defaults; a key in the file wins, the
  roles per role. `board explain` shows each resolved value with its source (`preset` or `set`), an
  `exec.verify` and a `models` row, and `·` for an absent optional key; `exec start` and `show` print the
  `workflow:` line. The ledger fixes the route at start, so an edit mid-lane changes no running lane, except
  `noteRounds`, which each step reads live from the workflow file.
  Under `final: after-fix` a recheck that passes every note sent back (`N1: PASS …` lines) on a tip moved
  only by fix commits closes with no final verifier. Notes past the budget are kept as `openNotes` in the
  ledger, `show` and the episode.
- **Rebase and the resolution recheck** — a land conflict on an exec lane names `lane exec rebase <id>`:
  the builder rebases onto main, the range-diff goes to `logs/range-diff-<n>.txt`, and a fresh verifier
  checks only its changed pairs (`exec.rebase: "recheck"`) before the gate on the new tip. A land on a
  branch moved past the tip its lane closed on is refused with the same pointer. `lane exec reverify <id>`
  sends a verifier to a lane the route closed without one, and a flagged one's merge names it.
- **`exec.flagField` and `exec.idleMinutes`** — the field the verify route reads (default `flag`, checked
  on every kind exec runs) and the idle threshold (whole minutes ≥ 5, default 20).
- **Steps and the owner's holds in a lane** — a contract may carry a `**Steps:**` part: numbered steps,
  an owner gate on any step ending `→ owner OK`, and acceptance items tagged `Step N:`. `lane exec` builds
  the steps in runs (one round up to each owner gate), holds the lane for the owner's review at a gate, and
  sends one fresh verifier over the whole contract after the last step, with the owner's approvals in its
  brief. `lane exec hold <id> --for owner` holds a round whose reply is saved; `--for later` parks a lane
  whose builder was stopped, its worktree kept, and `--agent` names the builder the resume goes back to. `lane exec resume <id> --note "<the OK>"` records the
  answer and resumes the builder (`--redo` builds the run again, `--fresh` sends a new builder). A held
  lane is no writer, writes no board cell and is refused by merge and close; `lane session start` lists it
  first. `exec show` and `lane session start` flag a building lane with no change for 20 minutes as idle.
  Build and verify briefs cap every command but the gate at 10 minutes.
- **Search-ready website** — icons from the tape mark (`favicon.ico`, 192/512 and maskable PNGs, the
  Apple icon, a web manifest, `theme-color`; icon URLs carry a version), `robots.txt`,
  `sitemap-index.xml`, `llms.txt` and `llms-full.txt` built from the docs pages, JSON-LD
  (`SoftwareApplication` and `WebSite` on the home page, `BreadcrumbList` on docs pages), a canonical,
  `og:url` and `og:locale` on every page except the 404, meta descriptions of at most 160
  characters, and a `vercel.json` with cache rules and safe headers.
- **Fewer round trips in a lane** — `exec.verify` in the process file (`all` by default, `flagged`,
  `none`) sends an item whose `flag` field is not set from built straight to the gate; a flagged item
  keeps its independent verifier and a flagged item with no verdict does not land. `flagged` needs a
  `flag` field on the lifecycle kind and is refused at load without it. The route shows in `exec start`
  and `show`, and the episode records it. `models` names the model each dispatch prints (`model:`):
  `build`, and `verify.default`, `verify.ui`, `verify.flagged`. Each is a name or `{ "default": …, "paths":
  [{ "when": { "any": [<globs>] }, "model": … }] }`, the first entry matching an owned file winning, and a
  contract line `- **Model:** <model>` (`- **Model (verify):** <model>` for the verifier) beats both; the
  `model:` line names where it came from, e.g. `opus (models.build.paths[0]: src/main/**)`. `board explain`
  and `exec start` warn `! models.verify.ui is unused` when the route never sends a UI task to a verifier. A
  verify, recheck or final brief on a tip whose gate is already recorded green says to read that gate, not
  to re-run it (`exec gate` rewrites the waiting verify brief). `lane merge` no longer stops on the owner's uncommitted `guard.allow` files: it
  sets them aside, recorded in the ledger first, lands, and puts them back; a stop or a rerun after a kill
  puts them back too, and an edit that no longer applies is saved to a patch file.
- **Board and briefs** — `board lifecycle`/`lane merge` write several commits into the Commit cell
  with the separator the board's done rows already use (a field's `join` pins it; `first…last` when
  nothing is learned). An old `--json '{…}'` on `board add`/`board set` exits 2 with a pointer to
  the new form, and every `--help` ends with the plugin version. `board explain` lists
  `worktrees.keep`, `guard.allow`, `cleanup.disposable`, `gate.flaky` and `gate.concurrency` when set,
  with what they match. `lane session start` flags `.agentry/NOTE.md` stale when every id it names
  is done. An exec brief also quotes decisions whose row names the task, and `exec start --cite`
  adds decisions by id. `exec owns --apply` keeps a section appended after the brief's last section.
- **Owned files read from a contract** — a path that is the tail of exactly one tracked file
  resolves to it (`merge/gating.mjs`), several are listed as ambiguous, none is new; brace globs
  (`commands/{go,spec}.md`) expand, and a glob or folder resolves by its folders. `a.b.c` symbols are
  not paths unless a tracked file matches, and `Makefile`, `Dockerfile`, `LICENSE` and tracked
  extensionless files are. `.astro` files and globs under `web`, `app` or `ui` suggest the designer.
  `exec start` warns, without refusing, when its owned files overlap a running lane's:
  `! owns overlap with T-4: plugin/commands/go.md`. A path that leaves the repository is dropped with
  `! owns names a path outside the repository`, a bare extension after `+`, `,` or `and` (`` `src/a.ts` +
  `.test.ts` ``) owns the sibling file, a path the clause says is out of scope (stops, needs context, never,
  ask first) is not owned, and `! owns names tests but no test file` says when no owned path is one.
- **`agentry` command** — the plugin's `bin/agentry` is on the Bash tool's PATH while the plugin is
  enabled: `agentry board …`, `agentry lane …`, `agentry draft …`, `--version`, `--help`. Next
  steps the CLIs print name it when it is this plugin's bin, and the docs use it; hosts without it
  keep `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"`. `/agentry:init` suggests the rule
  `Bash(agentry:*)`.
- **`lane exec fix <id> --notes N1,N3`** — a verified lane (`PASS WITH NOTES`) goes back to its
  builder on the notes the conductor names, then to the usual recheck. Verifiers now label their
  notes `N1`, `N2`, and so on.
- **Gate queue and flaky re-run** — `gate.concurrency` (default 1) makes lanes queue their gates
  behind a lock in `.agentry/run/`, with stale-process recovery, so timing tests stop failing under
  load. `gate.flaky` names tests that may fail under load: a red whose log fails only in them is
  re-run alone once, and both runs are recorded.
- **Flaky gate reds on the land, names from step logs, a queued gate speaks** — `lane merge`
  applies `gate.flaky` as `exec gate` does: a red only in listed tests is re-run alone once and
  both runs are recorded; a re-run that fails again stops without sending the builder back.
  `gate.flakyLogs` (globs from the gate's cwd or `$TMPDIR/`, files newer than the run) are read
  when the gate's own output prints only a summary: a line there counts only if it names a failing
  test (`FAILED TEST: <name>`, `not ok N - <name>`, `✗ <name>`, `FAIL <name>`); noise is ignored and
  a red that names no test stays real. A queued gate writes `waiting for gate slot N
  (held by … since HH:MM)` and `slot acquired` to its log, and `lane session start` lists held slots.
- **`gates` in the exec output** — `gate` and `verdict` print "1 green, 1 red on this tip", so a
  green run no longer hides a later red on the same commit.
- **`/agentry:exec <task-id>`** — builds a task whose contract is already written. It finds the
  contract in the repo's task files, briefs the implementer (or the designer for UI work) in a
  worktree, has an independent verifier check the acceptance, allows one fix round, and hands off
  the worktree, commits and verdict. No spec, plan or split, no Flow run state, no merge or push.
- **`/agentry:ask <question>`** — answers with one read-only specialist (explorer, researcher or
  architect) and cited sources. No worktree, no Flow run state, no edits.
- **`/agentry:init`** — the setup front door for a repo's own process. In a new repo it scaffolds
  a board from templates; in a repo with a board it learns how that board is written into
  `.agentry/process.json`, checked against the files at every step; in a repo already set up it
  shows the setup and offers repairs for drift. Asks only what it can't infer, never commits.
- **`/agentry:new <kind>`** — adds one item of any kind the process file knows (task, sprint,
  question, decision…) to every place that kind lives, asking only that kind's fields, then
  reports what changed in the board check.
- **`/agentry:board`** — the board's derived status, then every rule finding, from the repo's own
  files. `--fix` fills mechanical drift once the harness writers ship.
- **`process` skill** — the process file format, the learn procedure and fresh-repo templates.
- **`/agentry:merge <task-id>`** — lands one task on main: preflight, the repo's checks,
  cherry-pick, the gate, then the board's done row, SHA and handoff line in one commit. It writes
  its plan to the task's ledger before acting, so a killed merge can be rerun without losing the
  board writes it carries or picking twice, and it rolls back with `reset --keep`. Pushes only
  per the repo's push policy.
- **`/agentry:start` and `/agentry:close`** — open and close a working session. `start` prints
  the current sprint, work in flight, nudges, drafts and ranked memory in a few lines. `close`
  applies drafts, runs `board fix`, offers a sweep, writes pending episodes and a short note.
- **`lane sweep`** — reports, and with `--apply` removes, the worktrees of merged lanes and stops
  stray processes started under `.agentry/run/`. Unknown, live or dirty worktrees, and worktrees
  holding ignored files, are kept.
- **`mode` config key** — read by `start`.
- **`board status --ready`** — open tasks per sprint, with whether each has a contract and
  whether its dependencies are done.
- **`board status --why <id>`** says what an item is blocked by.
- **Process file keys:** `worktrees.keep` (worktrees kept on purpose are shown as kept, not
  drift), `status` (a hand-written status file whose "next" section is checked against the
  board), and a `mentions` field type so `refs-resolve` checks ids cited in text.
- **`ready-has-contract` rule** — an open task in an active sprint must have a contract that
  `board contract` finds.

### Changed
- **A verified lane's restart** — `lane exec restart <id> --carry` of a lane whose last verdict passed, on the
  tip it settled on and with no uncommitted work, that carries cleanly goes on as a rebase does instead of
  briefing a build round for work already done: under `exec.rebase: "recheck"` a changed carry goes to a fresh
  verifier reading the range-diff, any other carry to the gate on the new tip (or the close). The board's
  verdict is kept, `built` is written, and the old lane's verdicts open the new ledger, so a flagged item
  lands with no second verifier; they do not count toward the three-verdict stop. A conflict, a `FAIL`, no
  verdict or work after the verdict keeps the build round. A restart that stops after the archive clears the
  old verdict on the board, or names the `board set` call that does.
- **Inline steps are a steps problem** — `- **Steps:** 1. Build it 2. Ship it` is never parsed: `exec start`
  refuses it, and the message ends with a one-step-per-line rewrite to check before pasting. `board check`
  reports any Steps problem as a `ready-has-contract` finding (`contract <id>: …`), so it shows before
  `start` does.
- **Land and resume** — a `board set` or `board add --apply` made on main is carried into the board commit
  (it was put back uncommitted after it, so a verdict the board check needed, a flagged task's PASS, stopped
  the land); one the check refuses stops the land and goes back on main as it was. Once the gate has passed, a
  rerun accepts the owner's commit of a board fix (board files and `.agentry/*.json` only) and puts the board
  commit on top; any other commit after the picks still stops it.
- **`lane exec fix <id> --notes`** takes the notes a lane kept open as well as the latest verifier's.
- **Lifecycle writes check the board** — a lane's `dispatched`, `built` or `failed` status write that would
  add a finding the board did not have is skipped, with the rule and its message.
- **Gate commands die with their holder** — `lane exec gate` and `lane merge` run the gate under a watchdog
  that stops its process group within about a second once the process holding the slot is gone (a `kill -9`
  included) and frees the slot, so a second gate never starts beside a leftover. Agentry's git calls are
  bounded too (120 s, or `AGENTRY_GIT_TIMEOUT_MS`), so a stuck one cannot hold the gate, and a timed-out git's
  helpers go with it.
- **The standard preset is the default** — with no `exec` keys a lane now runs one notes-fix round (was
  three) and skips the final verifier after a recheck that covered every note on a fix-only tip. Set
  `exec.preset: "strict"` (or `noteRounds`, `final`) for the old budget and an always-fresh final.
- **Lane guards** — an uncommitted edit of `.agentry/process.json` or `workflow.json` that changes the
  `guard` or `gate` key trips the main guard (commit it between lanes); a lane held for the owner after a
  step can no longer be parked; a hold's evidence must be a file; a commit list git cannot read at a
  report is a read failure to check, never a subject to reword; the land and the lane read the newest gate
  record of the tier they need, and a recorded green is trusted only for the tier's current argv; the
  idle line says `(the last commit)` when that is the newest change.
- **Gate tiers, a gate per role, a manual checklist** — `gate.command` and `gate.quick` are replaced by
  `gate.tiers`: named tiers in precedence order, each an argv, every one but the last with a `when`
  (`only` globs, `any` globs, `flag: true`; any one holding is enough), the last the fallback. An old
  workflow file is refused at load with where each key goes now (the command becomes the last tier, a
  quick tier a tier with `when.only` before it). `gate.roles` says which tier `build`, `verify` and
  `merge` run (`pick`, `full` or a tier name; `verify` also `none`, the default, so a verifier runs no
  gate and `lane exec gate` while one is out exits 2). Gate records carry their `role` and `command`; the
  land skips only on a green worktree record of the tier and argv it needs, so a record from before tiers
  never skips. `gate.checklist` items are manual checks the land waits on when their `when` holds,
  recorded with `lane merge --check <name>=pass|fail` like a skill check. `gate.flaky` names are also
  read from `FAILED <name>`, a `<path>::<test>` token and JSON test events, and a listed name counts only
  whole. `board explain` shows `gate.tiers`, `gate.roles` and `gate.checklist`; `/agentry:init`
  proposes tiers.
- **Commits on main during a lane** — a commit that touches none of the lane's owned files and none of the
  files its worktree changed no longer stops the lane, whoever made it, and neither does one touching only
  `guard.allow` paths that no running lane owns (the report says `main moved by allowed commits: <n>
  (<shas>)`); a commit that overlaps names it: `<sha> touches <paths>, this lane's files`. A lane rebased by
  its builder starts its guard at the commit it sits on, so main's commits under the branch are not judged
  again. The process file, its workflow file and `.agentry/config.json` in use count as `guard.allow` paths
  unless a running lane owns them, as does every board location the process file names. A red gate after a
  green one on the same tip now says `the latest is red`, and the waiting verify brief carries the full gate
  line again. A ledger with no parsed owned list reads its contract against its worktree, as `start` does.
- **`/agentry:exec`** now drives the build and verify rounds through `lane exec`, records the
  gate, and stops a lane whose builder edited main outside its own board cells.
- **`board fix`** writes `done` only from a `lane merge` record whose commits are still on main.
  A hand merge is a nudge to `board fix --accept <id>`, which the owner confirms.
- **`/agentry:go`, `/agentry:ask`** recall memory first; `memory.prime` now sets what `start` and
  `exec` briefs carry.
- **One convention for `board` and `lane`.** Every subcommand has `--help` (usage, purpose, args,
  flags, exit codes, an example) and takes `--json`. A command that writes previews by default and
  writes only with `--apply`: `board fix --dry-run` and `--write` on `instructions` and
  `default-agent` are gone, and `/agentry:board fix` previews before `fix --apply`. Item fields go
  in `--fields` (`board add`, `board draft add`). Exit codes mean the same everywhere (0 ok, 1
  findings or stopped, 2 refused, usage or bad config), errors are one `✗ what: why → next` line,
  and ids are read in any case and in their cited form (`D7`).
- **`extensions.merge.checks: []`** is accepted and names no repo check.
- **`board contract`** finds a task's real contract on a lived-in board: shared blocks under
  every id they lead, contracts written as table rows, contracts in a file the task's row links,
  and a later one-line amendment no longer wins over the titled contract. Ids are read in any
  case. `/agentry:exec` briefs carry those later notes after the contract.
- **`board add`** fills a pattern id itself; `explain` and `check` refuse a conductor prompt or
  rules heading that doesn't exist, and `explain` lists which lanes are set up.
- **`board fix`** proves work is still on main by line history and file mode, not a text match,
  and asks git a fixed number of times per run.
- **`lane merge`** puts a carried board write back cell by cell, and a rerun after a kill acts
  only on what it can prove it wrote.
- **`lane sweep`** stops only what it can prove is a stray's, never an interactive shell or a live
  lane's process.
- **`board status`** shows what is on you, blocked and ahead even on a clean board; `start`
  prints the count first and the repo's `.agentry/NOTE.md`.
- **`lane exec` prints readable text** by default; `--json` prints the one object. `start` lists the
  owned files it parsed (new ones marked) and how to amend them.
- **Owned files** are paths only: symbols, string keys and spans after a negation ("no line in
  `x`") are left out, and `path:lines` reads as the path. They are parsed once at `start` into the
  ledger, so every later brief uses the same list.
- **`lane exec owns <id> [--set a,b | --add a,b] [--apply]`** shows or replaces the owned files, or adds
  to them (`--add`, for a builder that asked for a file it does not own), and rewrites the brief still
  waiting for its agent.
- **`lanes.maxWriters`** no longer counts worktrees the repo keeps (`worktrees.keep`) or the host's
  `.claude/worktrees/` agent worktrees that no lane owns.
- **`nested`** lists only worktrees inside the lane's own worktree, not every worktree created
  while it ran.
- **The main-touched guard** lets the conductor work on main while lanes run: a `board add` or
  `board set --apply` there is recorded and stops no lane (a hand edit of the same file still
  does), and files listed in the new `guard.allow` key may change, except a file a running
  lane's contract owns.
- **`lane merge --cleanup`** discards ignored files the new `cleanup.disposable` globs match
  (build output, import caches) without asking; any other ignored file still stops it.
  `/agentry:init` proposes the globs from `.gitignore`.
- **`lane exec` briefs and gate lock** — a notes-fix brief keeps its "Notes to fix" after
  `owns --apply`, and the recheck brief names the notes the builder was sent back on. Notes rounds
  stop at the `exec.noteRounds` budget. A bare file name in a contract's owns is looked up among the
  worktree's tracked files, and a bracketed aside no longer drops the next owned path. An empty or
  unreadable gate lock file is taken over, a lock refusal names the file, and the land's own gate
  on main waits behind the same lock.
- **Small fixes from the week** — `board scan` with no directory ends with a line naming the
  git-ignored folders that hold markdown it did not read. `--help` examples read `agentry board …`
  when the bin is on PATH. A `cleanup.disposable` glob naming a folder covers the files under it.
  `exec close` takes the episode's task line from the last build report. `lane session start`
  counts gate slots that do not fit (`+2 more`) and puts the stale-note step before its id list. A
  flaky re-run the land refused is recorded on the first gate run and named in the gate row. A
  `join` holding a line break or another control character is refused when the process file
  loads. `/agentry:init` offers lifecycle board writes once, saying what they write.

### Fixed
- **Branch names that differ only in case** — on a case-insensitive filesystem a read by name could open
  another branch's ref. `lane merge --branch` takes only a branch's own name exactly as git lists it, its tip
  from that line, and refuses a revision, a case twin, a branch with no commits yet and a worktree on a
  spelling no branch is named, with nothing written. Every merge call, `--check` included, reads the
  ledger's branch and tip from the branch list again, so a twin made since is refused, never landed.
  `lane merge --cleanup` and `lane sweep` delete a branch at its listed tip and keep one with a case twin,
  and the sweep says why it kept a removed worktree's branch (`kept <b>: it has a case twin <other>`, or
  `work not on main`). `lane exec restart` moves the branch at its listed tip and refuses, before writing
  anything, a lane branch or a kept name that clashes with another only in case.
- **The guard after a rebase** — a rebase that moves a lane's start no longer holds the lane for a board row
  that was mid-write at its start and committed since; an edit on main that was discarded rather than
  committed still trips.
- **`lane exec restart`** no longer counts an ignored empty directory as a file to lose.
- **Leftover temp files** — a gate's release removes the temp file a writer killed mid-write left beside its
  slot, and `lane sweep` also frees dead writers' temp files in `.agentry/run/` itself.
- **Flaky lock and gate tests under load.**
- **Locks and slots** — a lock or gate slot is freed on every exit of `agentry run` (a normal exit, an error,
  SIGINT, SIGTERM, SIGHUP) and stays held while the command's group has a member; slot files are written whole
  and every rewrite is serialized, so a reader never sees one empty and two riders are never lost. A holder's
  start time is read in UTC, so another time zone never frees a live holder, and a holder whose start cannot
  be read counts as alive.
- **`lane sweep`** freezes a stray and everything it started (SIGSTOP, looking again for new children) before
  it kills them, so a process that forks in its handler leaves nothing behind. Its preview no longer sweeps the
  temp files it reports.
- **Stacked lanes** — a restack and a queued gate no longer undo each other (the gate marks its intent before
  it reads the ledger and a restack refuses while the mark is live); a killed restack is read from its plan
  only when the old base is gone from the branch; `exec rebase` refuses a lane stacked on an unmerged parent
  and points at `restack`.
- **`board`** — `board add` refuses a field value holding a line break; `board fix` lists a landed item of a
  kind it does not write with the `board set` that records it; a process file whose `exec.kinds` names a kind
  another kind lists as its children is refused at load.

### Removed
- **All plugin hooks.** Their work moved into the commands above; the plugin check fails if a
  `hooks.json` returns.
- **The Workbench** (`/agentry:workbench`, its server and web app). Unused in practice: the board
  in markdown and `/agentry:start` show the same state without a second source of truth.
- **The flow MCP server** and the channels that rode on it. `/agentry:go`, `spec`, `plan`, `split`
  and `fix` keep their shapes and write the spec, plan and task files as plain files under
  `.agentry/work/<run>/`; review and approval happen in the chat. The plugin check fails if
  `plugin/` names either again.
- **`/agentry:go` with no task claiming queued work.** It now asks what to work on, and points to
  `agentry board status` and `/agentry:exec` when the repo has a board.

## [0.2.0] — 2026-06-21

The orchestration-substrate release: a durable run-state engine (Flow), a local
Agent Center to watch and steer runs (Workbench), live human↔agent channels, a
multi-page docs site — and a harness that now **enforces** its own process instead
of merely describing it.

### Added
- **Flow MCP** — the run-state engine. Task lifecycle, an append-only event log, a
  review sidecar, and content-hash versions, recorded as plain files under
  `.agentry/work/<run>/` that are the source of truth — stateless and restart-safe.
  The conductor opens a run (`run_start`), records routing and gates (`event_emit`),
  writes gate artifacts (`artifact_write`), and slices tasks (`task_create` /
  `task_assign` / `task_status`).
- **Workbench** — a per-project local Agent Center on `:4317` (`*.localhost`
  host-routing, one singleton server per project). A live React-Flow graph of the
  run, a docs workspace to read/edit/comment/approve artifacts, a read-only Memory
  browser, and Activity / Agents / Tokens / Gates pages — all rendered over the Flow
  files, never a second datastore. Launch with `/agentry:workbench [run]`.
- **Channels** — live human↔agent push over the file-watch loop: review comments,
  threaded `channel_reply`, a permission relay (approve a tool call from the
  Workbench), and forced task-status changes that steer the agent. Additive and
  research-preview; degrades gracefully to the async file-watch loop when off.
- **Docs & marketing site** (`packages/web`) — a multi-page `/docs` area (Quickstart,
  Install, Why, When, Capabilities + Flow/Memory/Workbench/Channels/Permissions,
  Self-Eval, Security, Changelog, Troubleshooting) with real Workbench/eval
  screenshots, alongside the landing site.
- **`flow-compliance` self-eval** — a probe that grades a run on observable Flow
  signals (a routing-decision event before dispatch, spec before tasks, single
  task frontmatter, no skipped-run flag).
- **`flow-run-guard` hook** — flags a `flow-skipped` marker when a gate artifact is
  written with no open run (the bypass), while leaving the one-shot floor untouched.

### Changed
- **The harness enforces its own process.** `/agentry:go` now makes `run_start` + the
  routing event the first action above the one-shot floor; the node commands, the
  eight agents, and the lifecycle skills are wired to Flow, the Workbench review loop,
  and the channel permission relay — the mandate moved from skill prose into the
  loaded command plus a runtime hook plus a measurement. The three routing modes and
  the one-shot floor are preserved.

### Fixed
- **architect:** task contracts were authored with a second stacked `---` block on top
  of Flow's own frontmatter, which rendered as a broken blob in the Workbench. Fixed at
  the authoring convention (a plain-markdown `## Contract` body) and with a defensive
  strip in Flow's task store.
- **workbench tests:** three server tests read the gitignored live `.agentry/work/`
  tree as their fixture and failed on a clean CI checkout — now sourced from a committed
  fixture copied into a temp tree at setup.
- **docs:** distinguish `--channels` (official, allowlisted channels) from
  `--dangerously-load-development-channels` (custom/preview channels, like Agentry's own
  bridge today).

## [0.1.2] — 2026-06-18

### Added
- This changelog.

## [0.1.1] — 2026-06-18

The "failure-to-merged" arc — Agentry can now take a change from a failure
report all the way to a merged, green branch.

### Added
- **`/agentry:fix`** — a repro-first debug front door: reproduce (a failing test
  that captures the bug) → isolate → fix → leave a regression guard → remember
  the gotcha. For a stack trace, a failing test, a red CI log, or a perf
  regression.
- **`/agentry:ship`** — the last mile: branch → commit → open PR → watch CI →
  merge, stopping at an **authorization boundary** before anything leaves the
  machine (push / PR-open / merge are gated by default, per-action configurable;
  auto-pilot records-and-stops, never auto-merges).
- **`shipping`** skill carrying that boundary and the last-mile playbook;
  conventions (VCS CLI, PR template, branch naming, CI provider, co-author
  trailer) are discovered from the target repo at runtime, not baked in.
- **Routing kind axis** — the conductor now classifies *kind*
  (`feature | bug | refactor | perf | dep-upgrade | ci-red`) orthogonally to the
  *complexity* shape (one-shot / spec-first / decompose+verify); kind selects the
  discipline, complexity selects the process weight.
- **Self-eval** gained a kind-axis routing probe and a gotcha-prevents-rebug
  moat scenario.

### Fixed
All three code bugs below were found by Agentry's own adversarial bug-hunt and
fixed through its debug loop — each with a regression test proven to fail
without the fix.
- **memory:** an explicit `supersedes` was silently swallowed by the
  dedup-reinforce path when the new fact's text near-duplicated an active fact,
  leaving the retired fact active and winning recall (high severity — corrupted
  the memory moat).
- **eval:** the one-shot/degenerate disambiguator counted the harness's own
  bookkeeping (`stream.jsonl`, primer logs) written into the working dir, so a
  no-output run was mis-scored `one-shot` instead of rejected as degenerate.
- **check-plugin:** the dist-lockstep gate was blind to transitive
  `@agentry/*` workspace-dependency staleness — a `@agentry/core` change could
  leave the bundled MCP stale while the gate reported "up to date."
- **ci:** the install-free release job no longer fails on `setup-node`'s pnpm
  cache-save (`package-manager-cache: false`).

## [0.1.0] — 2026-06-17

### Added
- Initial release: an adaptive agentic layer for Claude Code.
  - **Right-sized orchestration** — a conductor that routes a task to the least
    process that wins (one-shot → spec-first → decompose+verify) and sequences
    specialist subagents end to end.
  - **SDLC roster** — architect, designer, explorer, implementer, librarian,
    product-owner, researcher, and verifier, each backed by a craft skill.
  - **Durable memory MCP** — recall of precedent and gotchas that compounds
    across sessions (the moat).
  - **Self-eval harness** — measures the system's own routing and decision
    quality instead of asserting it works.

[Unreleased]: https://github.com/silentthreadstudio/agentry/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/silentthreadstudio/agentry/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/silentthreadstudio/agentry/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/silentthreadstudio/agentry/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/silentthreadstudio/agentry/releases/tag/v0.1.0
