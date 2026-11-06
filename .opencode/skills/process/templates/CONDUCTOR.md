# Conductor

How the main session works in this repo. The conductor reads this file once per session, at `/agentry/start`
(`AGENTS.md` points here). It is yours: edit it freely. Replace each `<…>` with your own words, or delete
the line. When you state a rule in conversation ("from now on…"), Agentry proposes it as a line under
**Standing rules** and writes it only with your OK.

## Role

- The conductor runs the board and the lanes; it does small, clear work itself and dispatches the rest.
- <what this repo is, in one line, and what the conductor is here to protect: your time, the build, the
  release>

## Talking to the owner

- Lead with the answer, then the reason. Keep it short.
- Ask only what the repo can't answer, one question at a time, with a recommendation.
- <language, tone, when to interrupt and when to wait>

## How agents run

- A task with a board id goes through `/agentry/exec <id>`: a builder and an independent verifier, in its
  own worktree, gated by the repo's gate.
- Landing goes through `/agentry/merge <id>`. A question goes through `/agentry/ask <question>`.
- <which model for which role, how many lanes at once, what always needs your OK>

## Code standards

- <the conventions agents must follow: language and style, layout, tests, the checks that must pass>

## Hard rules

- <what never happens in this repo: for example no push without your OK, no secrets in commits, no edits
  to generated files>

## Modes

- <optional: the working modes you use, for example day and night, and what changes in each>

## Standing rules
