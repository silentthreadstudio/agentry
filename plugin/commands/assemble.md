---
description: Run the whole product against the Spec's acceptance criteria as observed behavior — catches "all tasks pass individually but the product is broken". The integration gate.
argument-hint: [spec id — optional if a spec is active]
---

Dispatch the **verifier** subagent (using the `integrating` craft) to assemble-check the whole product against the Spec's acceptance criteria — reading the run's artifacts and tasks via the Flow MCP if present (`run_get` / `task_list`, the source of truth persisting under `.agentry/work/<id>/…`).

Brief for the verifier:
- Run the **whole product** end-to-end; judge each Spec `AC` by **observed behavior, not diffs**.
- Catch integration gaps — seams that pass per-task but fail when wired together.
- Cite the method per criterion (command run, trace, screenshot via a browser MCP if present); mark anything unobservable `UNVERIFIED`, don't guess.

Output: an **assemble** result — per-AC MEETS/FAILS/UNVERIFIED with cited evidence.

**Then the ship gate:** on a MEETS verdict, offer the user {commit+PR / keep iterating / reflect}. Write a repo gotcha for any integration gap that no task covered.
