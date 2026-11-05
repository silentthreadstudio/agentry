# A board learned by init

For a repo that already keeps its own board. This is the kind of `process.json` `/agentry:init` writes after
reading one: the repo's own kinds, columns and status words, nothing renamed.

## The board it describes

`PLANNING.md` holds two tables:

- **Iterations**: `Iteration`, `Goal`, `State` (`NEXT`, `NOW`, `SHIPPED`).
- **Backlog**: tickets `PLAT-<n>` with `Title`, `Iteration`, `State`, `Owner`, `Blocked by`, `Spec`, `Review`
  and `Landed in`. A ticket in no iteration says `ICEBOX`.

## What it sets

- Two kinds, `iteration` and `ticket`. A ticket's `Iteration` is its parent; `ICEBOX` is an allowed value
  that names no item (`also`).
- Upper-case states read case-blind (`"case": "upper"`) and mapped to Agentry's phases: `OPEN` planned,
  `IN-PROGRESS` and `IN-REVIEW` active, `CLOSED` done, `WONTFIX` dropped, `ICEBOX` parked.
- `Blocked by` is a list of tickets, checked by `deps-done`.
- `Spec` links each ticket's spec as `[contract](specs/PLAT-101.md)`. `agentry board contract` follows that
  link and reads the bold-led block in the file.
- `Landed in` is an `evidence` field: commits, or a note when the work landed some other way.
- `lifecycle` writes the repo's own words: `IN-PROGRESS` when a builder starts, `IN-REVIEW` when it reports
  done, `CLOSED` when the ticket lands; the verdict goes in `Review`, the commit in `Landed in`.
- `commits.subjectPattern`: every subject starts with its ticket, `PLAT-101: …`.
- `worktrees.keep`: worktrees named `release-*` are kept on purpose and never shown as drift.

## Files

| File | Goes to |
| :--- | :--- |
| `process.json` | `.agentry/process.json` |
| `workflow.json` | `.agentry/workflow.json` |
| `board/PLANNING.md`, `board/specs/` | the repo root (`root` is `.`) |

```
mkdir -p .agentry
cp process.json workflow.json .agentry/
cp -R board/* .
agentry board check
```

On your own repo, run `/agentry:init` instead: it scans the board, drafts this file from it, and checks the
draft with `agentry board explain` before it writes anything.
