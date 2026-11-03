# The process file — `.agentry/process.json`

Reference for the `process` skill. The process file describes how one repo writes its board: which kinds of
item it has, where each lives, what each field means, which rules hold and where the harness may write. The
checker (`board.mjs`) is the same in every repo; only this file differs. The fresh-repo version is
`templates/process.json`; read it next to this page.

JSON, no comments: a `note` on any kind or rule carries the human explanation. The schema is `ProcessSpec`
in `@agentry/core` (`packages/core/src/process.ts`); when this page and the schema disagree, the schema wins.

## Top level

| Key | Required | What |
| :--- | :--- | :--- |
| `version` | yes | `1`. A newer number means the file needs upgrading (init state (c)). |
| `name` | yes | Shown in the board header. |
| `root` | yes | Directory of the board, relative to the git root. Every path below is relative to it and must stay inside the repository. |
| `kinds` | yes | `{ "<kind>": Kind }`. The kind names are the repo's own (`task`, `story`, `ticket`…). |
| `rules` | yes | The rules turned on, each `{ "rule": "<catalog id>", …params }`. |
| `lifecycle` | no | What the harness writes as work moves. Absent: the checker never writes on its own. |
| `drafts` | no | How an answered question becomes a decision draft. |
| `status` | no | The derived view: `now` (the kind that is "current", e.g. `sprint`), `note` (the hand-written note, default `.agentry/NOTE.md`), `prime` (inject it at session start), `lines` (how many). |
| `gate` | no | The repo's gate: the command `exec` and `merge` run, its quick tier, the files it may leave changed. |
| `extensions` | no | Repo skills Agentry's commands run as extra checks (`merge.checks`). |
| `conductor` | no | The repo's conductor prompt and the heading standing rules are appended under. |

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
  `### T4 · …`, `bold` for `- **T4** …`; a table row `| T4 | … |` always counts). `board contract`
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
| `ready-has-contract` | an unfinished item in an active parent has a contract that `board contract <id>` finds (the build step, `/agentry:exec`, needs it) |
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
first landed commit, or `<first>…<last>`, as short SHAs) and `handoff` (`parent.file:<section>`, a bold-lead
section of the parent's file, where the `handoff` line is appended). A step with no `on` word or no `write`
key is skipped and reported, and without `lifecycle` nothing is ever written. Writes are mechanical only
and land in the user's files, visible in their diff; `board lifecycle <event> <id>` applies one event.

The `handoff` template is one line and fills `{id}`, `{sha}` (the first commit) and `{summary}`. When a
`done-has-handoff` rule checks the lifecycle's kind, the template is tried at load: filled with a fake SHA,
the line must pass that rule (a bold lead naming the id; with `commit: "first"` the SHA right after `(`),
and `write.handoff` must name the section the rule reads. Otherwise the file is refused, so the writer can
never append a line the checker rejects. Each `on` word must be one of the kind's status words. Only
`merged` may set a status whose phase is `done` (a task is done when it lands on main), and then `write`
must give every "done" rule on that kind what it reads: a `done-has-evidence` field gets `write.commit`; a
`done-signoff` date can't be written by the lifecycle, so that rule is refused on the lifecycle's kind.

`drafts.decision.map` fills a decision draft from an answered question: `{answer}` (the picked option),
`{question}`, `{unpicked}` (the options not picked). A draft is never written to the decisions file without
the owner's approval.

## gate, extensions and conductor

```json
"gate": {
  "command": ["scripts/gate.sh"],
  "quick": { "command": ["scripts/gate.sh", "--quick"], "only": ["docs/**", "*.md"] },
  "after": ["CHANGELOG.md"],
  "note": "the full gate takes about ten minutes"
},
"extensions": { "merge": { "checks": ["repo-merge-checks"] } },
"conductor": { "prompt": "docs/CONDUCTOR.md", "rules": "Standing rules" }
```

| Key | Required | What |
| :--- | :--- | :--- |
| `gate.command` | yes | The gate, as argv: run with no shell, in the git root of the tree under test; its exit code is the verdict. |
| `gate.quick` | no | A cheaper tier: `command` and `only`, both required. |
| `gate.quick.command` | yes | The quick tier's argv. |
| `gate.quick.only` | yes | Globs (from the git root). The quick tier applies only when every changed file matches one of them. |
| `gate.after` | no | Globs of the files allowed to change after the gate ran green. Default `[]`: none. |
| `gate.note` | no | Free text. |
| `extensions.merge` | yes | What `/agentry:merge` adds. |
| `extensions.merge.checks` | yes | Repo skills by their own names (lower-case letters, digits, `-`; each once). Merge refuses to land until each has a recorded outcome. |
| `conductor.prompt` | yes | The repo's conductor prompt, from the git root. |
| `conductor.rules` | no | The heading in that prompt where a standing rule the owner states is appended. Matched as the full heading text with its numbering (`## 10. Standing rules` is `"10. Standing rules"`, not `"Standing rules"`); spaces collapse, a leading `#` run also pins the level. |

These keys fail strict: a typo makes a check stricter or is refused, never laxer. An unknown key, a wrong
type, an empty string or list, a repeated check, or a path that is absolute or climbs out with `..` is refused
at load (exit 2, naming the path: `gate.command[1]`, `gate.quick.only`). A misspelled `after` glob allows
less; a misspelled `only` glob makes the quick tier apply less often.

`conductor.prompt` and `conductor.rules` are also read against the repo by `board explain` and `board check`: the
prompt must be a file inside it and hold the `rules` heading, matched the way `board draft apply` matches it.
A miss is exit 2 naming the key and what was looked for, with the nearest heading when one is close
(`"10. Standing rules"` for `"Standing rules"`).
