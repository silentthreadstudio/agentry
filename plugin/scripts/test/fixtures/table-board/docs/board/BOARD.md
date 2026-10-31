# Sample board

A synthetic board in the shape of a table board: each task row carries its own flag, verdict and
commit. Statuses and rules live in the process file.

## Milestones

| Milestone | Review question | Sprints |
| --- | --- | --- |
| M1 · First light | Does the loop hold for one evening? | A1, A2 |
| M2 · Open doors | Do new players find the way in? | B1 |

## Sprints

| Sprint | Name | Status | Owner OK |
| --- | --- | --- | --- |
| PRE | Work merged before this board | done | 2026-01-05 |
| A1 | [The loop](sprints/A1_the_loop.md) | done | 2026-01-12 |
| A2 | [The evening](sprints/A2_the_evening.md) | doing |  |
| B1 | [The door](sprints/B1_the_door.md) | todo |  |
| TRK | Tracks beside the sprints | doing |  |
| LATER | Deferred past this board | todo |  |

## Tasks

| Task | Sprint | Status | Deps | ⚑ | Verdict | Commit | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W0 | PRE | done |  |  |  |  | Carried over |
| W1 | A1 | done |  | ⚑ | PASS | a1b2c3d | The loop, headless |
| W2 | A1 | done | W1 |  |  | b2c3d4e 0f9e8d7 | `loop.mjs` split in two |
| **W3** | A2 | doing | W1, W2 | ⚑ | pass with notes |  | The evening clock |
| W4 | A2 | todo | W3 |  |  |  | Evening events |
| W5 | B1 | todo | W4 |  |  |  | The door \| the hinge |
| X-01 | TRK | doing |  |  |  |  | Store page copy |
| W9 | LATER | later |  |  |  |  | A second evening |

## Owner questions

| Id | Question (recommendation) | Status | Blocks | Answer |
| --- | --- | --- | --- | --- |
| Q-01 | Does the clock pause in menus? (**Yes**) | answered | W3 | N2 |
| Q-02 | Is the door locked on day one? (**No**) | open | W5 |  |
