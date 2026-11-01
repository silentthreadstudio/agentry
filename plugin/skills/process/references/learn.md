# Setting a repo up — what `/agentry:init` does

Reference for the `process` skill. Init has three states and one rule: the judgment is yours, every claim is
checked by `board.mjs`. Never write a mapping that `explain` has not confirmed, never commit.

`board` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"`. Exit 0 = OK, 1 = findings,
2 = usage or spec error.

## Pick the state

1. `.agentry/process.json` exists → **(c) set up**.
2. Else `board scan --json` lists a table whose first column holds ids, or contract blocks (bold-lead or
   heading blocks led by ids), or frontmatter documents with ids → **(b) existing process**.
3. Else → **(a) new repo**.

If `scan` finds something but the user says it is not their board, treat it as (a).

## (a) New repo — scaffold

1. Offer the kinds in `templates/process.json`: milestone, sprint, task, question, decision, and epic as an
   option (one question, epic unchecked by default).
2. Ask where the board goes; default `docs/work/`. Refuse a path outside the repository.
3. Copy `templates/BOARD.md`, `TASKS.md`, `PROCESS.md`, `DECISIONS.md` and `templates/sprints/` there. Never
   overwrite an existing file: stop and ask.
4. Write `.agentry/process.json` from `templates/process.json` with `root` set to that path. Without epics,
   drop `kinds.epic` and the `## Epics` section of `BOARD.md`.
5. Run `board check`; it must print OK. Tell the user the example rows (`M1`, `S1`, `T1`, `E1`) are theirs to
   replace.

## (b) Existing process — learn

Work on a draft, never on the real file: `.agentry/run/process/draft.json`, read with
`board explain --process .agentry/run/process/draft.json --json`.

1. **Kinds from `scan`.** Each board-like table is a candidate kind: its file, its heading (exact text), the
   id column (the first column whose cells look like ids). Name the kind with the repo's own word (the
   heading or the id column header, singular, lower-case). The same shape spread over one file per item
   (`stories/*.md` with an `id` key, or the id in the file name) is a `files` kind.
2. **Fields.** Map every column. Infer the type from the cells: comma-separated ids → `list` with `ref`;
   one id of another kind → `ref`; 7–40 hex tokens → `commits`; hex tokens mixed with words → `evidence`;
   `YYYY-MM-DD` → `date`; a glyph in some rows and blank in others → `flag` with `mark`; markdown links →
   `link` (it yields the link text, not the target). A cell holding two things (`M1 · Name`) gets one field per
   part, each with `match`.
3. **Tree.** A ref naming the kind whose table groups this one (a task's sprint) gets `role: parent`; a list
   on the grouping kind naming its members gets `role: children`. A kind with no status column but children
   gets `status: { "derived": "children" }`.
4. **Status.** Collect the distinct values of the status column and map each to a phase. Ask only about a
   word whose phase you cannot tell from the repo's process doc or from how the rows use it.
5. **Own files and contracts.** Files named after items (`sprints/S2_*.md`) → `file.glob`, with each section
   that lists items (`as: "table"` or `"bold-lead"`). Rows whose id has no file → `except`, or
   `required: false` when most have none. Contract blocks found by `scan` → `contract.blocks` and `lead`.
6. **Create.** From the rows as they are: columns a person decides go in `ask`; columns every new row starts
   with the same value (the planned status word) are literals; columns filled later stay `""`. The id is a
   pattern (`T{n}`) when existing ids follow one, else `ask`. If contracts sit under per-parent headings,
   add a block template with that heading.
7. **Iterate.** Run `explain` on the draft and fix it until every kind is found with items, no column is
   unmapped, no status word is unknown and every ref resolves. A value that is a parking word rather than an
   id (`LATER`) goes in that field's `also`. Stop after five rounds without progress and show the user what
   still doesn't map.
8. **Rules.** For each catalog rule whose fields exist (`references/format.md`), add it to the draft and run
   `board check --process <draft> --json`:
   - no findings → **on**;
   - the repo's process doc (`PROCESS.md`, `CONTRIBUTING.md`, a board header, an existing checker's comments)
     states it and it has findings → **ask**, showing the findings; a few special rows failing (a pre-board
     or catch-all sprint) is an `except`/`skip` to propose, not a rule to drop;
   - neither stated nor holding → **off**.
   When an existing checker names its rules (`R1`, `R2`…), offer them as `label`s.
9. **Summary, then write.** Show one line per kind (`kind · file › heading · N items`), the rules on, the
   rules asked about and the answer, then write `.agentry/process.json` and delete the draft.

`--relearn <kind>` runs steps 1–7 for that kind only, inside the existing file, and leaves every other kind
and rule as it is.

## (c) Set up — show and repair

1. Run `board explain`. Show kinds × location × count, rules on with their finding counts, the effective
   config (read it the way `/agentry:config` §1 does), and the `.agentry/` commit policy.
2. Drift is anything `explain` reports as missing: a heading not found (`scan` may show it renamed), a column
   gone or added, status words not in `values`, a `version` older than this plugin's. Report each as one
   line with its proposed repair.
3. Offer repairs one at a time; apply only the ones the user accepts, then rerun `explain`. With no drift
   and nothing asked, change nothing.

## The setup questions (every state)

Ask each once, only when it cannot be inferred, in one `AskUserQuestion` where possible:

- **Is `.agentry/` committed?** Infer first: `git check-ignore -q .agentry/process.json` succeeds →
  ignored; `git ls-files .agentry` lists files → committed. Ask only when neither tells. If the user wants
  it ignored and it isn't, propose the `.gitignore` line; don't edit `.gitignore` unasked.
- **Session-start status?** Sets `status.prime`.
- **Harness writes?** Yes keeps `lifecycle` (status, commit, verdict and handoff written as work moves); no
  removes it and the checker stays read-only.
- **Map the code?** Only when `.agentry/context.md` is missing: offer `/agentry:onboard`.

## Wiring the lanes (every state)

Once the process file loads, set up what `/agentry:exec`, `/agentry:merge`, `/agentry:start` and
`/agentry:close` use, in this order. A step already set up is shown, not asked again (`--relearn` aside).
Each change to `.agentry/process.json` goes through the draft: copy it to `.agentry/run/process/draft.json`,
edit the draft, run `board explain --process .agentry/run/process/draft.json` (exit 2 → fix the draft), then
write the real file and delete the draft. The keys are in `references/format.md` § gate, extensions and
conductor.

1. **The gate.** Learn it from the repo, in this order: the workflow doc (`PROCESS.md`, `WORKFLOW.md`,
   `CONTRIBUTING.md`) naming the merge gate; a gate script (`tools/ci/gate*`, `scripts/gate*`, a `Makefile`
   target such as `check` or `ci`); the CI config (`.github/workflows/*.yml`, `.gitlab-ci.yml`); the
   `package.json` scripts. Prefer the one command the repo itself calls its gate.
   - `gate.command` is argv, run with no shell in the git root: `["tools/ci/gate.sh"]`,
     `["pnpm", "run", "check"]`. Propose it as argv, never through a shell. With no single command, or
     steps that genuinely need a shell (`&&`, a pipe), point to the repo's own script that runs them
     (`scripts/gate.sh`) and offer to write one with the owner's OK.
   - `gate.quick` only when the repo has a cheaper tier with a stated scope (a `--quick` flag "for docs-only
     changes"): its `command`, and `only` globs for exactly that scope (`["docs/**", "**/*.md"]`).
   - `gate.after`: files the repo's workflow changes after the gate is green (a changelog written at merge).
     Default none.
   - Show the proposal with where each part came from, and confirm it. Don't run the gate unasked: it may be
     long. A gate that leaves files changed counts as red; say so when the script writes into the tree.
2. **The conductor prompt.** Look for the repo's own (a doc its instruction files or board point agents to
   as their operating prompt). Offer it, or the template `templates/CONDUCTOR.md` copied next to the board
   (`CONDUCTOR.md` in the process file's `root`; never overwrite), or none. Set `conductor.prompt` (from
   the git root) and `conductor.rules`, the heading standing rules are appended under (`Standing rules` for
   the template; for an existing file a heading of that kind, or propose adding one with the owner's OK).
   Without `rules`, a rule draft can't be applied.
3. **The trigger block.** Run `board instructions` and show its output: the block it would write between
   `<!-- agentry:begin v1 -->` and `<!-- agentry:end -->` in `AGENTS.md` (created if absent) and the
   `@AGENTS.md` line it would add to an existing `CLAUDE.md` (never created). Every host reads `AGENTS.md`;
   Claude Code reads it beside a `CLAUDE.md` only through that import. Project instructions can also live in
   `.claude/CLAUDE.md`: with no root `CLAUDE.md` the import goes there as `@../AGENTS.md` (relative to that
   file); with both, in the root one only. An import inside a code fence, an HTML comment or a code span
   doesn't count. On OK, `board instructions --write`; it writes both files or neither (exit 2 with the
   reason when one can't be written).
   Text outside the markers is never touched, and a re-run changes nothing. If the repo's instruction files
   carry a competing line (every task through `/agentry:go`, a hand checker to keep green), list it and
   propose its replacement; edit it only on the owner's OK.
4. **The default agent.** Run `board default-agent` and show `current`. Offer to make `agentry:conductor`
   the project's main-session agent: `board default-agent --write`, then `--verify` (static). A different
   `agent` already set is shown and replaced only on an explicit OK. The live check (`--verify live`) costs
   one small request (about 15k tokens); run it only with the owner's OK. Show `resolved` and `how`; on
   `no`, the cause. Say: it takes effect in the next session; `.claude/settings.local.json` overrides it;
   a teammate without Agentry falls back to plain Claude Code, silently.
5. **The push policy.** If `.agentry/config.json` has no `merge.push`, ask once: `ask` (default: ask at each
   merge), `auto` (push once a merge is green) or `never` (keep it local). A repo doc that says to push after
   every verified unit makes `auto` the recommendation, still asked. Write it project-local, merging, as
   `/agentry:config` §2 does.
6. **The merge skill.** If the repo has its own merge or landing skill (`.claude/skills/*/SKILL.md`), offer to
   name it in `extensions.merge.checks` by its own name: `/agentry:merge` then refuses to land until it
   has a recorded outcome. Propose its shrunk text: only the checks that are the repo's own (what a person
   must see, rules only this repo has, extra files to update), with the steps merge now does (cherry-pick,
   gate, board writes, push, cleanup) removed. Show the full proposed text; edit the skill only on the
   owner's OK, never unasked.

End with what was written (paths), what was left as it was, and the last `board check` result. Nothing is
committed: the user reviews the diff.
