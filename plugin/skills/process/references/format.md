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
  | `type` | `text` (default) · `list` (comma-separated) · `ref` (one id) · `flag` (cell contains `mark`) · `date` (leading `YYYY-MM-DD`) · `commits` (every 7–40 hex token) · `evidence` (commits plus the remaining text as a note) · `link` (the first markdown link's text, not its target; a cell without a link reads whole) |
  | `ref` | The kind (or list of kinds) a `ref`/`list` value names. A hit in two kinds is a finding. |
  | `role` | `parent` on the child's ref (a task's sprint), `children` on the parent's list (a milestone's sprints). Together they make the tree. |
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
- **`contract`** — where a task's contract block lives: `blocks` (files, first hit wins) and `lead`
  (`heading` for `### T4 · …`, `bold` for `- **T4** …`).
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

## Rule catalog

Every rule is a fixed function with parameters; there is no rule language. `kind` names the kind it checks;
`except: { "<field>": [values] }` skips matching items (`"id"` means the item's own id, any other key must be
a field of every kind the rule checks); `label` prints the repo's own name for the rule on each finding.

| Rule | Checks |
| :--- | :--- |
| `ids-unique` | no id twice in a kind |
| `status-known` | every status word is in `values` |
| `refs-resolve` | every `ref`/`list` value names an item (or an `also` literal) |
| `file-required` | an item with `file.required` has exactly one file (no `kind`: every kind whose file is required) |
| `members-listed` | the parent's own-file section lists exactly its children |
| `deps-done` | a started item's dependencies are all done (a sprint or milestone dep by its phase) |
| `parent-active` | a started item's parent is active or done |
| `sequential` | an item starts only after the one above it (row order) is done |
| `question-blocks` | nothing starts while an open question blocks it |
| `parked` | the parking parent's children are parked; nothing live depends on a parked item |
| `deps-not-forward` | no dependency on an item later in the order |
| `done-has-evidence` | a done item names its commit (`commit-or-note`: or a note), and every commit named exists in git |
| `done-has-handoff` | a done item has a line in its parent's handoff section (`commit`: the SHA that line must name) |
| `flagged-needs-verdict` | a flagged done item has a passing verdict |
| `closed-children` | a done parent's children are all closed |
| `done-signoff` | a done item carries a sign-off date |

Order is the row order of the parent kind's table: a task ranks with its sprint.

### Rule params

Every param each rule takes; any other key in a rule entry is an error. A param that names a field must name
one of the type shown, so an option never changes what a rule reads: a commits column is not a dependency
list. "The first field that fits" is the kind's first field of that type, and a kind with none is an error.
`parking` must be an item on the board of the kind the parent field refs, or one of that field's `also`
values.

| Rule | Param | Required | Default | Type |
| :--- | :--- | :--- | :--- | :--- |
| `file-required` | `kind` | no | — | a kind |
| `file-required` | `except` | no | — | `{ field or "id": [values] }` |
| `members-listed` | `kind` | yes | — | a kind |
| `members-listed` | `section` | yes | — | a section of the kind's file |
| `members-listed` | `member` | yes | — | a kind |
| `members-listed` | `except` | no | — | `{ field or "id": [values] }` |
| `deps-done` | `kind` | yes | — | a kind |
| `deps-done` | `field` | no | the first field that fits | a list field whose ref includes the rule's kind |
| `deps-done` | `except` | no | — | `{ field or "id": [values] }` |
| `parent-active` | `kind` | yes | — | a kind |
| `parent-active` | `except` | no | — | `{ field or "id": [values] }` |
| `sequential` | `kind` | yes | — | a kind |
| `sequential` | `skip` | no | `[]` | a list of strings |
| `sequential` | `except` | no | — | `{ field or "id": [values] }` |
| `question-blocks` | `kind` | yes | — | a kind |
| `question-blocks` | `field` | no | `"blocks"` | a list field with a ref |
| `question-blocks` | `except` | no | — | `{ field or "id": [values] }` |
| `parked` | `kind` | yes | — | a kind |
| `parked` | `parking` | yes | — | an item of the parent's kind, or an `also` value of the parent field |
| `parked` | `field` | no | the first field that fits | a list field whose ref includes the rule's kind |
| `parked` | `except` | no | — | `{ field or "id": [values] }` |
| `deps-not-forward` | `kind` | yes | — | a kind |
| `deps-not-forward` | `field` | no | the first field that fits | a list field whose ref includes the rule's kind |
| `deps-not-forward` | `skip` | no | `[]` | a list of strings |
| `deps-not-forward` | `except` | no | — | `{ field or "id": [values] }` |
| `done-has-evidence` | `kind` | yes | — | a kind |
| `done-has-evidence` | `field` | yes | — | a commits or evidence field |
| `done-has-evidence` | `evidence` | yes | — | `"commit"` or `"commit-or-note"` |
| `done-has-evidence` | `except` | no | — | `{ field or "id": [values] }` |
| `done-has-handoff` | `kind` | yes | — | a kind |
| `done-has-handoff` | `section` | yes | — | a section of the parent's file |
| `done-has-handoff` | `commit` | no | `"none"` | `"first"` or `"any"` or `"none"` |
| `done-has-handoff` | `field` | no | the first field that fits | a commits or evidence field, used only when commit is `"first"` or `"any"` |
| `done-has-handoff` | `except` | no | — | `{ field or "id": [values] }` |
| `flagged-needs-verdict` | `kind` | yes | — | a kind |
| `flagged-needs-verdict` | `flag` | yes | — | a flag field |
| `flagged-needs-verdict` | `verdict` | yes | — | a text field |
| `flagged-needs-verdict` | `pass` | yes | — | a list of strings |
| `flagged-needs-verdict` | `except` | no | — | `{ field or "id": [values] }` |
| `closed-children` | `kind` | yes | — | a kind |
| `closed-children` | `except` | no | — | `{ field or "id": [values] }` |
| `done-signoff` | `kind` | yes | — | a kind |
| `done-signoff` | `field` | yes | — | a date field |
| `done-signoff` | `except` | no | — | `{ field or "id": [values] }` |

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
leaves the status where it is; only the merge makes a task done. `write` names the field each value goes to
(several may share one evidence field). Writes are mechanical only (status, commit, verdict, handoff stub)
and land in the user's files, visible in their diff.

`drafts.decision.map` fills a decision draft from an answered question: `{answer}` (the picked option),
`{question}`, `{unpicked}` (the options not picked). A draft is never written to the decisions file without
the owner's approval.
