# Release board

A synthetic board in the shape of an evidence board: one free-text evidence column per task, and
dependencies that name tasks, sprints or milestones.

## Milestones
| Milestone | Sprints |
| --- | --- |
| K0 · Groundwork | K0 |
| K1 · First users (0.2) | K1a, K1b |

## Sprints
| Sprint | Name | Status | Owner OK |
| --- | --- | --- | --- |
| K0 | [Groundwork](sprints/K0_groundwork.md) | doing | |
| K1a | Lanes and lists | todo | |
| K1b | Reports | todo | |

## Tasks
| Task | Sprint | What | Status | Depends on | Commit / verdict |
| --- | --- | --- | --- | --- | --- |
| K0-1 | K0 | Set up the gate | done | | 1a2b3c4 |
| K0-2 | K0 | Move the repo | done | K0-1 | moved 2026-02-01; links updated |
| K0-3 | K0 | Tidy the docs | done | K0-2 | 2b3c4d5, 3c4d5e6; verifier PASS WITH NOTES |
| K0-4 | K0 | Check the setup after a restart | verify | | 4d5e6f7; restart check left |
| H1 | K1a | First lane | todo | K0 | |
| H2 | K1a | Second lane | doing | K0, H1 | |
| H3 | K1b | Report view | todo | K1 | |
| H8 | LATER | Media helper | later | | |

## Owner questions
| # | Question | Status | Answer |
| --- | --- | --- | --- |
| Q1 | Keep the name? | answered | Yes (P1) |
| Q2 | Ship a beta first? | open | |
