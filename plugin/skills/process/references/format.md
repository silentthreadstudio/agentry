# The process and workflow files — `.agentry/process.json` and `.agentry/workflow.json`

Reference for the `process` skill. The process file describes how one repo writes its board: which kinds of
item it has, where each lives, what each field means and which rules hold. Its sibling, the workflow file,
says how the harness works the repo: what it writes as work moves, the gate, the conductor prompt, the
guard, the cleanup and the exec lane. The checker (`board.mjs`) is the same in every repo; only these files
differ. The fresh-repo versions are `templates/process.json` and `templates/workflow.json`; read them next to
this page.

JSON, no comments: a `note` on any kind or rule carries the human explanation. The schemas are
`ProcessBoard` (`packages/core/src/process.ts`) and `Workflow` (`packages/core/src/workflow.ts`) in
`@agentry/core`; when this page and the schemas disagree, the schemas win.

The workflow file is always the sibling `workflow.json` of the process file in use (`--process
.agentry/run/process/process.json` reads `.agentry/run/process/workflow.json`). It is optional: with none,
every workflow key is absent. A key put in the other file is refused at load (exit 2), naming the file it
belongs in: `gate is a workflow key: it belongs in workflow.json`, `kinds is a board key: it belongs in
process.json`.

## process.json: top level

| Key | Required | What |
| :--- | :--- | :--- |
| `version` | yes | `1`. A newer number means the file needs upgrading (init state (c)). |
| `name` | yes | Shown in the board header. |
| `root` | yes | Directory of the board, relative to the git root. Every path below is relative to it and must stay inside the repository. |
| `kinds` | yes | `{ "<kind>": Kind }`. The kind names are the repo's own (`task`, `story`, `ticket`…). |
| `rules` | yes | The rules turned on, each `{ "rule": "<catalog id>", …params }`. |
| `status` | no | The derived view: `now` (the kind that is "current", e.g. `sprint`), `note` (the hand-written note, default `.agentry/NOTE.md`), `prime` (inject it at session start), `lines` (how many), `file` and `next` (a hand-kept status file, see the last section). |

## workflow.json: top level

No `version`, and every key is optional.

| Key | Required | What |
| :--- | :--- | :--- |
| `lifecycle` | no | What the harness writes as work moves. Absent: the checker never writes on its own. |
| `drafts` | no | How an answered question becomes a decision draft. |
| `worktrees` | no | `{ "keep": [names or globs] }`: worktrees kept on purpose. |
| `gate` | no | The repo's gate: its tiers (the commands `exec` and `merge` run), the tier each role runs, a manual checklist, the files it may leave changed. |
| `extensions` | no | Repo skills Agentry's commands run as extra checks: `merge`, `start` and `close` (`<phase>.checks`); at least one. |
| `conductor` | no | The repo's conductor prompt and the heading standing rules are appended under. |
| `guard` | no | `{ "allow": [globs] }`: main-checkout files a running lane's guard lets change. |
| `cleanup` | no | `{ "disposable": [globs] }`: ignored files a lane's cleanup discards without asking. |
| `exec` | no | `{ "preset": "lean" \| "standard" \| "strict", "verify": "all" \| "flagged" \| "none", "noteRounds": 0–3, "final": "never" \| "after-fix" \| "always", "rebase": "recheck" \| "gate", "flagField": "<field>", "idleMinutes": ≥ 5, "kinds": { … } }`, every key optional. `preset` (default `standard`) sets `verify` (lean `flagged`, else `all`), `noteRounds` (0 / 1 / 3), `final` (`never` / `after-fix` / `always`), `rebase` (`gate` / `recheck` / `recheck`) and the `gate.roles` defaults (strict: build and merge `full`); a key given here wins, `gate.roles` per role. `verify`: which items get an independent verifier; `noteRounds`: the notes-fix rounds a lane may run; `final`: when a fresh final verifier follows a recheck (`after-fix`: unless it covered every note sent back on a tip moved only by fix commits); `rebase`: what checks a rebase that cleared a land conflict; `flagField` (default `flag`): the flag field `verify` reads, which every kind exec runs must have as a flag field; `idleMinutes` (default 20): when a building lane is idle; `kinds`: the kinds it runs beside the lifecycle's (debt). A `flagged` route, given or from `lean`, with no such field is refused at load naming its source. See "exec and models" and "exec kinds". |
| `models` | no | `{ "build": <model>, "verify": { "default", "ui", "flagged" } }`: the model each exec dispatch names. Each `<model>` is a name (`"sonnet"`) or `{ "default": "<model>", "paths": [{ "when": { "any": [<globs>] }, "model": "<model>" }] }` (both keys required, `paths` non-empty): the first entry whose `any` glob matches one of the item's owned files names it (the gate tiers' glob matching), else `default`. A contract bullet `- **Model:** <model>` (builder rounds) or `- **Model (verify):** <model>` (verifier rounds) wins over both. Each dispatch's `model:` line names its source: `opus (contract)`, `opus (models.build.paths[0]: src/main/**)`, `sonnet (models.build)`, `sonnet (models.build.default)`. `board explain` warns `! models.verify.ui is unused` when `exec.verify` is `flagged` or `none` and `verify.flagged` is set (an unflagged UI task gets no verifier, a flagged one takes `verify.flagged`), and so does `exec start`'s route line for an unflagged UI task. See "exec and models". |
| `briefs` | no | `{ "build": ["<line>", …], "verify": ["<line>", …] }`: repo policy lines printed in every builder or verifier brief. See "briefs and commits". |
| `commits` | no | `{ "subjectMax", "subjectPattern", "forbid": ["<regex>", …] }`: rules a builder's commits must keep. See "briefs and commits". |
| `locks` | no | `{ "<name>": <slots> }` (slots at least 1, e.g. `{ "editor": 1 }`): named locks shared by every worktree. `agentry run --limit <dur> --lock <name> -- <cmd>` waits for a slot (up to `--wait`, default 10m, then exit 75) and holds it while the command runs; `agentry lock take <name>` / `drop <name>` hold one across tool calls (a shared editor driven through MCP), until its ttl (default 30m) or its session ends; `agentry lock show` lists the holders. |

## Kind

- **`label`** — the display name. **`note`** — free text.
- **`at`** — where the items are. Either rows of a table, `{ "table": "BOARD.md", "heading": "Tasks" }`
  (the heading text, any level, with or without its `#` marks, spaces collapsed; the first table under it), or
  one file per item, `{ "files": "stories/*.md", "id": "frontmatter:id" }` or `"id": "filename:{id}.md"`.
- **`id`** — `column` (table kinds), optional `match` (regex, group 1 is the id, e.g. `^(\\S+)` for a cell
  like `M1 · First release`) and `prefix` (display only, e.g. `D` for decisions numbered `1, 2…`).
- **`fields`** — `{ "<name>": Field }`, each read from a column header (or a frontmatter key):

  | Field key | Meaning |
  | :--- | :--- |
  | `column` | The header text, exactly. Column order never matters. |
  | `type` | `text` (default) · `list` (comma-separated) · `ref` (one id) · `flag` (cell contains `mark`) · `date` (leading `YYYY-MM-DD`) · `commits` (every 7–40 hex token) · `evidence` (commits plus the remaining text as a note) · `link` (the first markdown link's text, not its target; a cell without a link reads whole) · `mentions` (free text; reads every `<prefix><digits>` token in it, e.g. `D2`, once each) |
  | `ref` | The kind (or list of kinds) a `ref`/`list`/`mentions` value names. A hit in two kinds is a finding. |
  | `prefix` | On a `mentions` field (which also needs `ref`): the letters before the number, e.g. `{ "type": "mentions", "ref": "decision", "prefix": "D" }`. A mention `D2` resolves to the item with id `D2`, else the one with id `2` (kinds that number plainly); `refs-resolve` reports one that names none. A prefix inside a word or a longer token (`AD2`, `D2x`, `D2.5`) is no mention. |
  | `role` | `parent` on the child's `ref` field (a task's sprint), `children` on the parent's `list` field (a milestone's sprints). Together they make the tree. |
  | `also` | Literal values allowed besides ids (a parking word such as `LATER`). |
  | `join` | On a `commits` or `evidence` field the lifecycle writes: what goes between several landed commits, e.g. `" "` or `", "`. It has no letters, digits, line breaks or other control characters; a file that has one is refused when it loads. Without it, the separator the board's done rows already use is learned (the most common text between two SHAs in one cell), and `<first>…<last>` is written when none is. A range mark (`…`, `..`) as the separator writes `<first>…<last>`; any other joins every SHA. |
  | `mark`, `match`, `case` | The flag glyph; a regex applied before the type; `upper` to compare case-blind. |

  Cells are read plain: `**` and backticks are stripped, `\|` is a literal pipe.
- **`status`** — `{ "field": "status", "values": { "<word>": Phase } }`, or `{ "derived": "children" }`
  for a kind with no status column (all children closed → done; any started → active; else planned).
  Phases are the fixed words every rule speaks: `planned`, `active`, `done`, `dropped`, `parked`.
  Started = active or done; closed = done, dropped or parked.
- **`file`** — the item's own file: `glob` with `{id}` (`sprints/{id}_*.md`), `required`, `except` (ids
  with no file), `sections` (`{ "handoff": { "heading": "Handoff", "as": "bold-lead" } }`, or
  `"as": "table"` with the `column` holding ids). A bold lead names every id that is a token of it:
  `**T4/T5**` names both, `**T4 merged**` names T4.
- **`contract`** — where a task's contract block lives: `blocks` (files) and `lead` (`heading` for
  `### T4 · …`, `bold` for `- **T4** …`; a table row `| T4 | … |` always counts). `agentry board contract`
  searches the files the task's own rows link as `[contract](path#anchor)` (on the board or in its
  parent's file) first, then `blocks`. A titled or owning block (`**T4 · Door**`, `owns …`) beats an
  `accept`-only line, which beats a bare amendment or deps line; the others come back as `related`.
  Two titled or owning blocks are `ambiguous` unless the task's link names one.
- **`create`** — how `/agentry:new` adds one: `ask` (the fields to ask, nothing else), `id` (a pattern such
  as `T{n}` or `Q-{n:02}`, `{n}` for plain numbers, or `ask`), `rows` and `blocks`:
  - row: `{ "in": "self" | "parent.file:<section>", "at": "end" | "after-last:<field>", "cells": { "<header>": "<template>" } }`
  - block: `{ "file": "TASKS.md", "under": "<heading template>" | "ask", "text": "<template>" }`
  - templates fill `{id}`, `{<field>}`, `{parent.<field>}` and `{today}`. A kind without `create` cannot be
    added by `new`. A parent given as an `also` value (`LATER`) is no item: its file's rows and any block
    that names `{parent.…}` are skipped, and `add` says which.

Kind order matters once: when two links claim the same child (a task's `sprint` ref and an epic's `tasks`
list), the link in the kind listed first decides the child's order. List a grouping kind such as `epic`
after `task`, so tasks keep their sprint's order.

### What the reader assumes

The reader and the rules take these for granted; a file that breaks one is refused when it is loaded (exit 2,
naming the key), because the rules would otherwise run on links or phases that are never there and print OK.

- **Ids** — a table kind names its `id.column`; a files kind takes its id from `frontmatter:<key>` or
  `filename:<pattern with {id}>`; every `match` is a valid regex.
- **Refs** — `ref` is read only from a `ref`, `list` or `mentions` field, and names at least one declared kind. `case` is
  read only on a text field (on a ref it would change the id before it is looked up). A `mentions` field needs
  both `ref` and `prefix`; `prefix` is read only on one.
- **The tree** — a kind has at most one field with role `parent`, of type `ref` (a parent is one id); a field
  with role `children` is a `list`. A role field of another type would link nothing.
- **Rank** — the one number the order rules (`deps-not-forward`) compare, defined without regard to the
  order the kinds are declared in. A kind that a `parent` field refs (the sprint) ranks by row order, from 0.
  Any other item takes the lowest rank among its parents (a task in a sprint and in an epic is as early as
  the earlier); one that no parent ranks takes the highest among its children (a milestone is as late as its
  last sprint); one neither reaches has no rank and is never ordered. Both are fixed points, so a cycle of
  parents or children ends, its members sharing the rank that reaches them.
- **Status** — the phases are the five words above; `status.field` names a text field of the kind, and when
  that field reads `case: "upper"` every status word is upper case. A status word is looked up as the reader
  makes it of a cell, which trims it and strips `**` and backticks, so a word with spaces, a line
  break, `**` or backticks can never match and is refused. `derived: "children"` needs a child kind
  with a status (a kind whose parent field refs it, or its children list); without one every item stays
  planned.
- **Sections** — an `as: "table"` section names its id `column`; `done-has-handoff` reads a `bold-lead`
  section.

## Rule catalog

Every rule is a fixed function with parameters; there is no rule language. `kind` names the kind it checks;
`except: { "<field>": [values] }` skips matching items (`"id"` means the item's own id, any other key must be
a field of every kind the rule checks); `label` prints the repo's own name for the rule on each finding.
An `except` or `skip` value that no item on the board holds (and that is no status word or `also` value the
file declares for that field, nor an item of the kind the field refs) is a finding of its own,
`rules[3].except.sprint names no item "PREE"`, so a typo shows instead of quietly changing what the rule skips.

| Rule | Checks |
| :--- | :--- |
| `ids-unique` | no id twice in a kind |
| `status-known` | every status word is in `values` |
| `refs-resolve` | every `ref`/`list`/`mentions` value names an item (or an `also` literal) |
| `file-required` | an item with `file.required` has exactly one file (no `kind`: every kind whose file is required) |
| `members-listed` | the parent's own-file section lists exactly its children |
| `deps-done` | a started item's dependencies are all done (a sprint or milestone dep by its phase) |
| `parent-active` | a started item's parent is active or done |
| `sequential` | an item starts only after the one above it (row order) is done |
| `question-blocks` | nothing starts while an open question blocks it |
| `parked` | the parking parent's children are parked; nothing live depends on a parked item |
| `deps-not-forward` | no dependency on an item later in the order |
| `ready-has-contract` | an unfinished item in an active parent has a contract that `agentry board contract <id>` finds (the build step, `/agentry:exec`, needs it) |
| `done-has-evidence` | a done item names its commit (`commit-or-note`: or a note), and every commit named exists in git |
| `done-has-handoff` | a done item has a line in its parent's handoff section (`commit`: the SHA that line must name) |
| `flagged-needs-verdict` | a flagged done item has a passing verdict |
| `closed-children` | a done parent's children are all closed |
| `done-signoff` | a done item carries a sign-off date |

Order is the row order of the parent kind's table: a task ranks with its sprint (see "Rank" above).

### Rule params

Every param each rule takes; any other key in a rule entry is an error. A param that names a field must name
one of the type shown, so an option never changes what a rule reads: a commits column is not a dependency
list. "The first field that fits" is the kind's first field of that type, and a kind with none is an error.
`parking` must be an item on the board of the kind the parent field refs, or one of that field's `also`
values. A kind must have what the rule needs of it (a kind "with" the capabilities below, or a field that
refs a kind with them), or the file is refused naming the param: a rule given a kind it cannot check would
check nothing and print OK. `file-required` without `kind` checks every kind whose file is required, and
refuses a file where no kind's is. Likewise `status-known` refuses a file where no kind has status
`values`, and `refs-resolve` one where no field has a `ref`.

| Rule | Param | Required | Default | Type |
| :--- | :--- | :--- | :--- | :--- |
| `file-required` | `kind` | no | — | a kind with `file` |
| `file-required` | `except` | no | — | `{ field or "id": [values] }` |
| `members-listed` | `kind` | yes | — | a kind |
| `members-listed` | `section` | yes | — | a section of the kind's file |
| `members-listed` | `member` | yes | — | a kind with `child` |
| `members-listed` | `except` | no | — | `{ field or "id": [values] }` |
| `deps-done` | `kind` | yes | — | a kind with `started` |
| `deps-done` | `field` | no | the first field that fits | a list field whose ref includes the rule's kind |
| `deps-done` | `except` | no | — | `{ field or "id": [values] }` |
| `parent-active` | `kind` | yes | — | a kind with `started`, `parent`, `parent-status` |
| `parent-active` | `except` | no | — | `{ field or "id": [values] }` |
| `sequential` | `kind` | yes | — | a kind with `started` |
| `sequential` | `skip` | no | `[]` | a list of ids of the kind's items |
| `sequential` | `except` | no | — | `{ field or "id": [values] }` |
| `question-blocks` | `kind` | yes | — | a kind with `active` |
| `question-blocks` | `field` | no | `"blocks"` | a list field with a ref, to a kind with `started` |
| `question-blocks` | `except` | no | — | `{ field or "id": [values] }` |
| `parked` | `kind` | yes | — | a kind with `parked`, `parent` |
| `parked` | `parking` | yes | — | an item of the parent's kind, or an `also` value of the parent field |
| `parked` | `field` | no | the first field that fits | a list field whose ref includes the rule's kind |
| `parked` | `except` | no | — | `{ field or "id": [values] }` |
| `deps-not-forward` | `kind` | yes | — | a kind with `order` |
| `deps-not-forward` | `field` | no | the first field that fits | a list field whose ref includes the rule's kind |
| `deps-not-forward` | `skip` | no | `[]` | a list of ids of the kind's items or their parents |
| `deps-not-forward` | `except` | no | — | `{ field or "id": [values] }` |
| `ready-has-contract` | `kind` | yes | — | a kind with `parent`, `parent-status` |
| `ready-has-contract` | `skip` | no | `[]` | a list of ids of the kind's items or their parents |
| `ready-has-contract` | `except` | no | — | `{ field or "id": [values] }` |
| `done-has-evidence` | `kind` | yes | — | a kind with `done` |
| `done-has-evidence` | `field` | yes | — | a commits or evidence field |
| `done-has-evidence` | `evidence` | yes | — | `"commit"` or `"commit-or-note"` |
| `done-has-evidence` | `except` | no | — | `{ field or "id": [values] }` |
| `done-has-handoff` | `kind` | yes | — | a kind with `done`, `parent` |
| `done-has-handoff` | `section` | yes | — | a bold-lead section of the parent's file |
| `done-has-handoff` | `commit` | no | `"none"` | `"first"` or `"any"` or `"none"` |
| `done-has-handoff` | `field` | no | the first field that fits | a commits or evidence field, used only when commit is `"first"` or `"any"` |
| `done-has-handoff` | `except` | no | — | `{ field or "id": [values] }` |
| `flagged-needs-verdict` | `kind` | yes | — | a kind with `done` |
| `flagged-needs-verdict` | `flag` | yes | — | a flag field |
| `flagged-needs-verdict` | `verdict` | yes | — | a text field |
| `flagged-needs-verdict` | `pass` | yes | — | a list of strings |
| `flagged-needs-verdict` | `except` | no | — | `{ field or "id": [values] }` |
| `closed-children` | `kind` | yes | — | a kind with `done`, `status-field`, `children` |
| `closed-children` | `except` | no | — | `{ field or "id": [values] }` |
| `done-signoff` | `kind` | yes | — | a kind with `done` |
| `done-signoff` | `field` | yes | — | a date field |
| `done-signoff` | `except` | no | — | `{ field or "id": [values] }` |

### Kind capabilities

What a rule needs of a kind before it can check it, as the params table names them.

| Capability | A kind has it when it has |
| :--- | :--- |
| `done` | a status that can be "done" |
| `started` | a status that can be started ("active" or "done") |
| `active` | a status that can be "active" |
| `parked` | a status that can be "parked" |
| `status-field` | a status field of its own (a derived status is done only once its children are) |
| `parent` | a field with role "parent" |
| `parent-status` | a parent kind with a status |
| `children` | children (another kind whose parent field refs it, or a children list) |
| `child` | a parent field that refs the rule's kind, or a place in a children list of the rule's kind |
| `file` | its own file ("file") |
| `order` | an order (it, its parent or its children sit in a kind a parent field refs) |

## lifecycle and drafts

In `workflow.json`:

```json
"lifecycle": {
  "kind": "task",
  "on": { "dispatched": "doing", "built": "verify", "failed": "doing", "merged": "done" },
  "write": { "status": "status", "verdict": "verdict", "commit": "commit", "handoff": "parent.file:handoff" },
  "handoff": "- **{id}** ({sha}): {summary}"
}
```

`on` maps the harness events to the kind's own status words: a builder dispatched, a builder reporting done,
a verifier failing it, its commits landing on the default branch. A verifier pass writes the verdict and
leaves the status where it is; a `FAIL` verdict also applies `failed`; only the merge makes a task done.
`write` names where each value goes, and takes exactly these keys: `status` (the kind's status field),
`verdict` (a text field: `PASS`, `PASS WITH NOTES` or `FAIL`), `commit` (a commits or evidence field: the
first landed commit, or several joined by the separator the board's done rows use (the field's `join` pins
it), `<first>…<last>` when nothing is learned, as short SHAs) and `handoff` (`parent.file:<section>`, a bold-lead
section of the parent's file, where the `handoff` line is appended). A step with no `on` word or no `write`
key is skipped and reported, and without `lifecycle` nothing is ever written. Writes are mechanical only
and land in the user's files, visible in their diff; `agentry board lifecycle <event> <id>` applies one event.

The `handoff` template is one line and fills `{id}`, `{sha}` (the first commit) and `{summary}`. When a
`done-has-handoff` rule checks the lifecycle's kind, the template is tried at load: filled with a fake SHA,
the line must pass that rule (a bold lead naming the id; with `commit: "first"` the SHA right after `(`),
and `write.handoff` must name the section the rule reads. Otherwise the file is refused, so the writer can
never append a line the checker rejects. Each `on` word must be one of the kind's status words. Only
`merged` may set a status whose phase is `done` (a task is done when it lands on main), and then `write`
must give every "done" rule on that kind what it reads: a `done-has-evidence` field gets `write.commit`; a
`done-signoff` date can't be written by the lifecycle, so that rule is refused on the lifecycle's kind.

`drafts.decision.map` fills a decision draft from an answered question: `{answer}` (the picked option),
`{why}` (the reason given; the draft's `question` when it has no why), `{question}`, `{unpicked}` (the options
not picked, joined with commas). Any other placeholder is refused. With no `drafts.decision`, `board draft apply`
derives a map from the decision kind's own `decision`, `why` and `rejected` fields. A draft is never written to
the decisions file without the owner's approval.

## gate, extensions and conductor

In `workflow.json`:

```json
"gate": {
  "tiers": [
    { "name": "docs", "command": ["scripts/gate.sh", "--quick"], "when": { "only": ["docs/**", "*.md"] } },
    { "name": "tests", "command": ["scripts/gate.sh", "--tests"], "when": { "only": ["src/ui/**", "tests/**"] } },
    { "name": "full", "command": ["scripts/gate.sh"] }
  ],
  "roles": { "build": "pick", "verify": "none", "merge": "pick" },
  "checklist": [
    { "name": "ui-smoke", "text": "Open each changed screen; no errors in the console", "when": { "any": ["src/ui/**"], "flag": true } }
  ],
  "after": ["CHANGELOG.md"],
  "note": "the full gate takes about ten minutes"
},
"extensions": {
  "merge": { "checks": ["repo-merge-checks"] },
  "start": { "checks": ["repo-session"] },
  "close": { "checks": ["repo-session"] }
},
"conductor": { "prompt": "docs/CONDUCTOR.md", "rules": "Standing rules" }
```

| Key | Required | What |
| :--- | :--- | :--- |
| `gate.tiers` | yes | The gate's tiers, in precedence order (at least one). Every tier but the last has a `when`; the last has none: it is the fallback. |
| `gate.tiers[].name` | yes | Lower-case letters, digits and `-`; unique; never `pick` or `none`. `full` names only the last tier. |
| `gate.tiers[].command` | yes | The tier, as argv: run with no shell, in the git root of the tree under test; its exit code is the verdict. |
| `gate.tiers[].when` | no | When the tier applies: one or more of `only`, `any`, `flag`, and it holds when any one of them does. Required on every tier but the last, refused on the last; `{}` is refused. |
| `gate.tiers[].when.only` | no | Globs (from the git root): holds when every changed file matches one. No changed files never matches. |
| `gate.tiers[].when.any` | no | Globs: holds when some changed file matches one. |
| `gate.tiers[].when.flag` | no | `true` only (`false` is refused): holds when the item's `flag` field is set. |
| `gate.roles` | no | The tier each role runs: `pick` (the first tier whose `when` holds, else the last), `full` (the last tier) or a tier's name. Default `build: pick`, `verify: none`, `merge: pick`. A value that names no tier is refused, listing the tier names. |
| `gate.roles.build` | no | The tier `lane exec gate` runs when no verifier is out (after the verdict, or with no verifier). |
| `gate.roles.verify` | no | The tier `lane exec gate` runs while a verifier is out; also `none`: the verifier runs no gate (its brief says the gate is not its), the lane runs the build tier after the verdict, and `lane exec gate` while a verifier is out exits 2. |
| `gate.roles.merge` | no | The tier the land runs on main, picked on the files the picks change and the lane's flag. The land skips it only on a green worktree record of that same tier and argv (see `merge.md`). |
| `gate.checklist` | no | Manual checks the land waits on, each recorded like a merge check: `lane merge <id> --check <name>=pass\|fail`, on the branch's tip. |
| `gate.checklist[].name` | yes | Lower-case letters, digits and `-`; unique; never an `extensions.merge.checks` name. |
| `gate.checklist[].text` | yes | What to check, as the checks row shows it. |
| `gate.checklist[].when` | no | When the item applies, as a tier's `when` (on the files the branch changes past main, and the lane's flag). No `when`: every land. |
| `gate.checklist[].when.only` | no | As `gate.tiers[].when.only`. |
| `gate.checklist[].when.any` | no | As `gate.tiers[].when.any`. |
| `gate.checklist[].when.flag` | no | As `gate.tiers[].when.flag`. |
| `gate.after` | no | Globs of the files allowed to change after the gate ran green. Default `[]`: none. |
| `gate.concurrency` | no | How many lane gates may run at once in this checkout. Default `1`: lanes queue their gates behind a lock in `.agentry/run/`, so load-sensitive tests are not run against each other. |
| `gate.flaky` | no | Names of tests known to fail under load. A red gate whose output fails only in these is re-run alone once, by `lane exec gate` and by the land (`lane merge`) alike; both runs are recorded. The gate's output (or the `gate.flakyLogs` files) must name each failing test, else every red is real. |
| `gate.flakyLogs` | no | Globs of extra logs (a gate's step logs) read for failure names, only when the gate's own output has no failure line, only a summary. Each is from the gate's cwd, or starts with `$TMPDIR/` (the temp directory); no absolute path, no `..` and no `.` segment. Only files modified since the gate run started are read. In them a line counts only if it names a failing test (`FAILED TEST: <name>`, `not ok N - <name>`, `✗ <name>`, `FAIL <name>`, `FAILED <name>` (the next token), a failure line holding a `<path>::<test>` token, or a JSON object line with a string `"test"` whose `status`, `outcome`, `result` or `event` is `fail`, `failed`, `failure` or `error`, any case); unnamed noise such as an engine's `ERROR:` line is ignored. A JSON line that is not a failure, and a count line (`2 failed, 10 passed`, `FAILED: 2`), names none. A listed name counts only whole: `test_slow` does not cover `test_slow_case`. If they name no failing test either, the red stays real. |
| `gate.note` | no | Free text. |
| `extensions.merge` | no | What `/agentry:merge` adds. |
| `extensions.merge.checks` | yes | Repo skills by their own names (lower-case letters, digits, `-`; each once); `[]` names none. Merge refuses to land until each has a recorded outcome. |
| `extensions.start` | no | What `/agentry:start` adds. |
| `extensions.start.checks` | yes | Repo skills as `merge.checks` names them (`[]` names none). `/agentry:start` runs each and records it: `lane session start --check <skill>=pass\|fail`. The same skill may be named in `close`. |
| `extensions.close` | no | What `/agentry:close` adds. |
| `extensions.close.checks` | yes | As `start.checks`, for `/agentry:close`: `lane session close --check <skill>=pass\|fail`. Nothing refuses a close over a failed or pending check; the handoff names each. |
| `conductor.prompt` | yes | The repo's conductor prompt, from the git root. |
| `conductor.rules` | no | The heading in that prompt where a standing rule the owner states is appended. Matched as the full heading text with its numbering (`## 10. Standing rules` is `"10. Standing rules"`, not `"Standing rules"`); spaces collapse, a leading `#` run also pins the level. |

These keys fail strict: a typo makes a check stricter or is refused, never laxer. An unknown key, a wrong
type, an empty string or list (`<phase>.checks` aside: `[]` is no check), a repeated check, or a path that is absolute or climbs out with `..` is refused
at load (exit 2, naming the path: `gate.tiers[0].command[1]`, `gate.tiers[0].when`). A misspelled `after`
glob allows less; a misspelled `only` glob makes its tier apply less often. `gate.command` and `gate.quick`
(before 0.3) are refused with where they go now: the command becomes the last tier (`{ "name": "full",
"command": […] }`), a quick tier a tier with `"when": { "only": […] }` before it.

`conductor.prompt` and `conductor.rules` are also read against the repo by `agentry board explain` and `agentry board check`: the
prompt must be a file inside it and hold the `rules` heading, matched the way `agentry board draft apply` matches it.
A miss is exit 2 naming the key and what was looked for, with the nearest heading when one is close
(`"10. Standing rules"` for `"Standing rules"`).

## status file and kept worktrees

`status` is in `process.json`, `worktrees` in `workflow.json`:

```json
"status": { "file": "docs/STATUS.md", "next": "Next" },
"worktrees": { "keep": ["scratch-*", "release"] }
```

- `status.file` and `status.next` (a path from the repository root, and a heading in that file) name a
  status file kept by hand. `agentry board status` and `session start` nudge once when an id listed under that
  heading is already done on the board, so the file does not drift. Both are optional; the nudge needs both.
- `worktrees.keep` is a non-empty list of names or globs (`*` and `?`), matched against a worktree's
  branch and its directory name. A match is shown as *kept* in `agentry board status`, never as drift.

## exec and models

In `workflow.json`:

```json
"exec": { "verify": "flagged" },
"models": { "build": "sonnet", "verify": { "default": "sonnet", "ui": "opus", "flagged": "opus" } }
```

- `exec.verify` is `"all"` (the default: every item goes from built to a verifier, then the gate),
  `"flagged"` (only an item whose `flag` field is set has a verifier; any other goes from built straight to the
  gate, which stands in for it) or `"none"` (no item is routed to a verifier unless its flag is set). An item
  whose flag is set always has its verifier, however the route is set, and a flagged item with no verdict does
  not land. `"flagged"` needs a field named `flag` of type `flag` on every kind exec runs (the lifecycle kind,
  `task` with no lifecycle, and each `exec.kinds` key); without it the file is refused at load. With no `gate`, a verifier is still sent: nothing else
  would check the work. `agentry lane exec start` and `show` print the route, and the episode records it.
- `models` names are free text: any string, every key optional, nothing checked against a list of models.
  Each key (`build`, `verify.default`, `verify.ui`, `verify.flagged`) is a name or a model by path:

  ```json
  "build": { "default": "sonnet", "paths": [{ "when": { "any": ["src/main/**"] }, "model": "opus" }] }
  ```

  Both keys are required and `paths` is not empty; the first entry whose `when.any` glob (the gate tiers'
  glob matching) matches one of the item's owned files names the model, else `default`.
- Each `lane exec` dispatch prints a `model:` line: the builder rounds use `build`; a verifier round uses
  `verify.flagged` when the item's flag is set, else `verify.ui` when the suggested builder is the designer (an
  owned path is UI-shaped), else `verify.default`. A key left out falls back to `verify.default`, and with
  no name for a dispatch it prints no `model:` line. A contract bullet `- **Model:** <model>` names the builder
  rounds' model and `- **Model (verify):** <model>` the verifier rounds' (its first word, backticks dropped),
  winning over the workflow file's. The line names the source: `opus (contract)`,
  `opus (models.build.paths[0]: src/main/**)`, `sonnet (models.build)`, `sonnet (models.build.default)`.
  Nothing here changes which agent runs.

## briefs and commits

In `workflow.json`:

```json
"briefs": { "build": ["Use pnpm, never npm."], "verify": ["Read CHANGELOG.md for the change."] },
"commits": { "subjectMax": 72, "subjectPattern": "^(feat|fix|docs)\\(.+\\): ", "forbid": ["^Co-Authored-By:"] }
```

- `briefs.build` and `briefs.verify` are each a non-empty list of at most 20 one-line strings (a line break is
  refused at load). Every builder brief (build, fix, continue) prints `build`, every verifier brief (verify,
  recheck, final) prints `verify`, as a `## Repo policy (overrides the contract where they differ)` section of
  one bullet per line after the contract. A line is printed as written: a `{{name}}` in it is not a slot. A role
  with no list gets no section.
- `commits` keys are all optional. The subject is a commit message's first line, counted in code points.
  `subjectMax` is a whole number above 0. `subjectPattern` is a regular expression the subject must match (no
  flags, so case counts). `forbid` is a non-empty list of regular expressions none of which may match the whole
  message, checked with the `m` flag so `^` and `$` hold at each line (e.g. an attribution trailer). `$` does not
  match before a CR, so a CRLF message needs `\r?$`. An invalid regular expression or an empty entry is refused at
  load.
- `lane exec report` sends the builder back (a fix round, once) for a commit past base that breaks a rule. `lane
  merge --preflight` shows a `commits` row, and the land refuses before any pick, when a commit it would pick does.

## exec kinds

In `workflow.json`, beside `exec.verify`:

```json
"exec": {
  "kinds": {
    "debt": {
      "on": { "dispatched": "doing", "built": "verify", "failed": "doing", "merged": "done" },
      "write": { "status": "status", "verdict": "verdict", "commit": "commit" }
    }
  }
}
```

| Key | Required | What |
| :--- | :--- | :--- |
| `exec.kinds.<kind>` | no | A kind exec and merge run beside the lifecycle's: the key names a declared kind with no parent field. |
| `on` | yes | The status word each harness event sets, as in `lifecycle.on`. |
| `on.dispatched` | no | A builder dispatched (`lane exec start`). |
| `on.built` | no | The builder reported done. |
| `on.failed` | no | A verifier failed it. |
| `on.merged` | no | Its commits landed on main; the only event that may set a `done` status. |
| `write` | no | Where each value goes, as in `lifecycle.write`, with no `handoff`. |
| `write.status` | no | The kind's status field. |
| `write.verdict` | no | A text field for the verdict. |
| `write.commit` | no | A commits or evidence field for the landed commits. |

An entry is the `lifecycle` mapping with no `kind` (the key names it) and no handoff: the item sits outside
the tree, so a land writes its status and commit cell and skips the handoff. The kinds exec runs are
`lifecycle.kind` and then each key; `exec.kinds` (even empty) needs a `lifecycle`, and a key that is the
lifecycle's kind, an undeclared kind, a kind with a parent field or another kind's parent is refused at load,
as is any other key in an entry. The
checks `lifecycle` gets hold for each entry too, under `exec.kinds.<kind>.on.*` and `.write.*`: each `on` word
is a status of the kind, only `merged` sets a `done` one, and a `done-has-evidence` rule on the kind reads the
field `write.commit` names.

Its items take a light contract in the kind's `contract.blocks`, led by the id:

```markdown
### DEBT-2 · Rename the helper
- **Owns:** `src/helper.ts`, `src/helper.test.ts`
- **Acceptance:** the old name is gone and the tests pass
```

`agentry lane exec start DEBT-2` refuses it (exit 2, nothing written) when its Owns line names no path or it
has no bold `Acceptance` label with text after it (a label inside a code fence does not count). An id is read in any case and must name one item of one
of these kinds; one that two kinds hold is refused. `agentry board status` shows each kind on its own row
after On you (`Debt       2 open · DEBT-3 doing · 5 done`), never in Now, In flight, On you, Blocked or Ahead;
a clean board shows the row only while something is open.

## guard and cleanup

In `workflow.json`:

```json
"guard": { "allow": ["docs/STATUS.md", "docs/plans/**"] },
"cleanup": { "disposable": ["**/.godot", "**/*.translation", "build"] }
```

- `guard.allow` is a non-empty list of globs (from the repository root; `**` crosses directories, as in
  `gate.after`). While a lane runs, an uncommitted edit in the main checkout to a file one of them matches
  does not stop it, unless a running lane's contract owns that file: an edit there still does. A commit on
  main still does too. `agentry board add` and `agentry board set --apply` need no entry: each write is recorded and let
  through as exactly what it wrote. `agentry lane merge` lets such an edit stand too: it sets it aside
  (recorded in the ledger first), lands, and puts it back as it was, so a land no longer stops on it. Any
  other uncommitted change still refuses the land.
- `cleanup.disposable` is a non-empty list of globs for ignored files `agentry lane merge --cleanup` discards without
  asking (build output, import caches). A wholly ignored directory is matched as its path (`build`,
  `**/.godot`; `build/**` also takes `build` itself). Any other ignored file still stops the cleanup and is
  listed for the owner.
