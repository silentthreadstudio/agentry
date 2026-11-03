---
name: process
description: This skill should be used when working with a repo's own process through Agentry — setting it up (scaffolding a fresh board, learning an existing board into `.agentry/process.json`, repairing drift), adding a task, sprint, question, decision or any other learned kind where that kind lives, or reading and acting on `board.mjs` status and findings. Loaded by /agentry:init, /agentry:new and /agentry:board.
version: 0.1.0
---

# Process

Agentry fits the process a repo already has; it does not bring its own. The repo's board stays in the
repo's files, in the repo's format. One file, `.agentry/process.json`, says how that board is written; one
dependency-free script, `board.mjs`, reads it, checks it and is the only thing that writes board items.
The split is fixed: **judgment in the session, every claim checked by the script.**

## The CLI

`node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" <sub> [--root <git root>] [--process <file>] [--json]`.
The process file defaults to `<git root>/.agentry/process.json`. Exit 0 = OK, 1 = findings, 2 = usage or
spec error (including a missing process file: point to `/agentry:init`).

| Sub | Does | Writes |
| :--- | :--- | :--- |
| `check` | runs the enabled rules, prints findings | nothing |
| `status` | the derived view: what's current, in flight, under review, next, blocked | nothing |
| `scan` | every table, id-led block and frontmatter document in the repo's tracked markdown | nothing |
| `explain` | per kind: found?, items, unmapped columns, unknown status words, unresolved refs; per rule: findings; the `lanes` block (what is wired, each ✓ or ✗ with its command) | nothing |
| `contract <id>` | the item's contract block | nothing |
| `next-id <kind>` | the next free id from the kind's `create.id` pattern | nothing |
| `add <kind> --json '<fields>'` | inserts the item at every `create` location; refuses a duplicate id | board files |
| `set <kind> <id> <field>=<value>` | one mechanical field | board files |
| `fix` | fills mechanical drift, reports the rest | board files |

Pass user text to `--json` as one single-quoted argument, with each `'` written as `'\''`. Show the
script's output as printed; don't re-derive what it already computed.

## The write rule

- **Mechanical** (status, commit, verdict, a handoff stub) is written into the user's files by `board.mjs`,
  visible in their diff. **Judgment** (a decision, scope, priority, opening a sprint, a sign-off) is never
  written without the owner: it is a draft or a report line.
- Never hand-edit a board row the script can write; never commit or push. The user reviews the diff.
- Everything Agentry owns lives in `.agentry/`: the process file, `NOTE.md` (the short hand-written note
  the status view shows), and `run/process/` (drafts and short-lived state, never committed). Whether the
  rest of `.agentry/` is committed is the user's call, made once in init.

## The commands

- **`/agentry:init`** — the setup door: scaffold (new repo), learn (existing board), show and repair (set up).
  Procedure: `references/learn.md`.
- **`/agentry:new <kind>`** — ask only the kind's `create.ask` fields, show exactly what will be written,
  `add`, then `check` and report the delta.
- **`/agentry:board`** — `status` then `check`; `--fix` for mechanical drift.

## Additional resources

### Reference files
- **`references/format.md`** — the process file: kinds, locations, field types, phases, own files,
  contracts, create templates, the rule catalog with its parameters, lifecycle and drafts.
- **`references/learn.md`** — init's three states step by step: scaffold, learn (scan → draft → explain →
  rules), show and repair; the setup questions.

### Templates
- **`templates/`** — a fresh board: `BOARD.md`, `TASKS.md`, `PROCESS.md`, `DECISIONS.md`,
  `sprints/S1_first_sprint.md` and the matching `process.json` (epic optional). Generic words, example ids
  the user replaces.
