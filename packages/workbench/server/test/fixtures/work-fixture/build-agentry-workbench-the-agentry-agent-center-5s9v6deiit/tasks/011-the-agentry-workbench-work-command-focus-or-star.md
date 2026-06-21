---
title: the /agentry:workbench [work] command (focus-or-start, ADR-002)
status: done
lockedBy: implementer
assignee: implementer
version: 081e2df226167c5f
---

---
phase: 1
kind: feature
status: todo
deps: [3, 7]
parallel_safe_with: [6, 8, 9, 10]
---

## Goal
Author `plugin/commands/workbench.md` — the `/agentry:workbench [work]` command implementing the focus-or-start flow: probe `/healthz`; up ⇒ open the deep link (focus); down ⇒ detached-spawn the server, poll until ready, write pidfile, open. Never two servers (ADR-002, AC1).

## Contract
- **owns:** `plugin/commands/workbench.md`
- **exposes:** the `/agentry:workbench [work]` slash command. Behavior: resolve project root → probe `http://127.0.0.1:4317/healthz` → **up** ⇒ open `http://<work || (bare)>.localhost:4317` → **down** ⇒ spawn `node ${CLAUDE_PLUGIN_ROOT}/workbench/server/index.js` detached, poll `/healthz` until ready, open the deep link.
- **must NOT touch:** `packages/**`, `server/src/**` — the command is markdown payload only; it spawns the committed `plugin/workbench/server/index.js` (task 3's artifact).

## Approach
- Inherit ADR-002: the port bind is the singleton lock, so a second invocation always lands on the **up** path (focus, no spawn). Probe `/healthz` on `127.0.0.1` directly (not `*.localhost`). Deep link uses `<work>.localhost:4317` when a work arg is given, bare `localhost:4317` (Works home) otherwise.
- **Reload-gated** (recalled): a new plugin command registers only on plugin reload/restart — note in the task that live verification (AC1 focus-or-start, AC10) happens after a restart in Phase 5.
- Match the existing `plugin/commands/*.md` conventions (read one, e.g. an existing agentry command, for frontmatter/structure). `${CLAUDE_PLUGIN_ROOT}` resolves the spawn path.
- This is a ~bounded markdown command — right-sized as one file (not over-structured).

## Acceptance
- The command file is valid plugin-command markdown; `node scripts/check-plugin.mjs` passes its structure/namespacing checks.
- Logic (read by inspection + Phase-5 live run): up→focus, down→spawn+poll+open, second invocation→focus. Pin: spawns `${CLAUDE_PLUGIN_ROOT}/workbench/server/index.js`.
- Advances AC1; live focus-or-start proven in Phase 5 (after reload). Verifier checks the file + the flow logic.
