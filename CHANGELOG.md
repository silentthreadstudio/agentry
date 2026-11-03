# Changelog

All notable changes to Agentry are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Pre-1.0, the version
scheme is pragmatic: patch releases carry fixes, docs, and small additions.

## [Unreleased]

### Added
- **Board and briefs** — `board lifecycle`/`lane merge` write several commits into the Commit cell
  with the separator the board's done rows already use (a field's `join` pins it; `first…last` when
  nothing is learned). An old `--json '{…}'` on `board add`/`board set` exits 2 with a pointer to
  the new form, and every `--help` ends with the plugin version. `board explain` lists
  `worktrees.keep`, `guard.allow`, `cleanup.disposable`, `gate.flaky` and `gate.concurrency` when set,
  with what they match. `lane session start` flags `.agentry/NOTE.md` stale when every id it names
  is done. An exec brief also quotes decisions whose row names the task, and `exec start --cite`
  adds decisions by id. `exec owns --apply` keeps a section appended after the brief's last section.
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
- **`lane exec owns <id> [--set a,b] [--apply]`** shows or replaces the owned files and rewrites the
  brief still waiting for its agent.
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
  stop after three notes rounds. A bare file name in a contract's owns is looked up among the
  worktree's tracked files, and a bracketed aside no longer drops the next owned path. An empty or
  unreadable gate lock file is taken over, a lock refusal names the file, and the land's own gate
  on main waits behind the same lock.

### Removed
- **All plugin hooks.** Their work moved into the commands above; the plugin check fails if a
  `hooks.json` returns. Known limit: without the hooks, nothing records the session's active run,
  so review comments on a run reach every session instead of only its own, and the Workbench
  token chart stays empty.

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
