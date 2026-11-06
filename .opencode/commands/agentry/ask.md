<!-- Generated from plugin/commands/ask.md by scripts/build-opencode.mjs — edit the source, not this file. -->
---
description: Answer a question about this repo, a library or a design with one read-only specialist and cited sources. No worktree, no run, no edits.
---

Answer this question through the **ask lane**:

$ARGUMENTS

First run `agentry mem recall --query "<the question's subject>"` and pass what it returns to the specialist as part of the brief. Then dispatch exactly **one** specialist, chosen by where the answer lives (brief template in the `conducting` skill's `references/lanes.md`):
- **explorer** (default) — how this repo works, where something lives, why it behaves as it does.
- **researcher** — the answer is outside the repo: a library's current API, a standard, an external service.
- **architect** — a design question: how something should be structured, which approach fits.

Brief it to answer in its reply and change nothing: no edits, no commits, no files written (no plan, ADR or research doc, nothing under `.agentry/`), no memory writes (recall is read-only). Every claim cites its evidence: `path:line` for code, a URL for outside sources. No `isolation: "worktree"`.

Relay the answer with its citations and mark what the specialist could not verify. If the question is really a request to change something, say so and point to `/agentry/exec` or `/agentry/go` instead of building.
