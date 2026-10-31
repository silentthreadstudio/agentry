# Process

How work moves on this board. `/agentry:board` checks every rule below; the checker's settings are in
`.agentry/process.json`.

## Kinds

- **Milestone** — a release-sized goal. Done when all its sprints are.
- **Sprint** — a short block of tasks. Sprints run in board order; its file in `sprints/` holds the goal,
  the exit checks and the handoff.
- **Task** — one row on the board and one contract in `TASKS.md`.
- **Epic** (optional) — a theme grouping tasks across sprints. Done when all its tasks are closed.
- **Question** — something only the owner can answer. While open it holds the tasks it blocks.
- **Decision** — one numbered row in `DECISIONS.md`, never edited after the fact.

## Status

Task: `todo` → `ready` (contract written) → `doing` → `verify` (built, under review) → `done` (on the
default branch, gate green). Off the path: `cut` (dropped), `later` (parked). Sprint: `todo`, `doing`,
`done`. Question: `open`, `answered`.

## Rules

1. Every id is unique within its kind, every status is one listed above, every reference names an item
   that exists.
2. A task starts only when everything it depends on is `done`, and never depends on a task in a later
   sprint.
3. A task starts only inside a sprint that is `doing` or `done`.
4. A sprint starts only when the one above it is `done`.
5. A task is `done` with its commit in the Commit column and a handoff line in its sprint's file.
6. A sprint is `done` when every task in it is closed (`done`, `cut` or `later`) and the owner has signed it
   off with a date.
7. A task blocked by an open question does not start.

## Definition of done

The task's commits are on the default branch, the gate is green, an independent reviewer passed it, and
rule 5 holds.
