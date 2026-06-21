---
title: "instance: port-lock + pidfile (OS-enforced singleton, ADR-002)"
status: done
assignee: implementer
version: 4417e3cdb6b5162c
---

---
phase: 1
kind: feature
status: todo
deps: [3]
parallel_safe_with: [6, 8]
---

## Goal
Implement the singleton mechanism: `port-lock` (bind `:4317` = the lock; EADDRINUSE ⇒ "already up") and `pidfile` (`.agentry/run/workbench.json` atomic read/write + liveness probe). The OS-enforced single-instance guarantee (ADR-002, AC1).

## Contract
- **owns:** `packages/workbench/server/src/instance/port-lock.ts`, `packages/workbench/server/src/instance/pidfile.ts`
- **exposes:** `port-lock` — a bind-or-fail primitive returning "I am the server" on success, "already up" on `EADDRINUSE`; `pidfile` — atomic write `{ pid, port, startedAt }` (tmp-then-rename, the pattern FLOW's `run-pointer.ts` uses), read, liveness via `process.kill(pid, 0)`, remove on graceful shutdown. Pin: the pidfile path `.agentry/run/workbench.json` and its JSON shape (the command in task 11 reads it).
- **must NOT touch:** `transport/`, `application/`, `domain/`, `index.ts` (the composition root in task 9 wires these in).

## Approach
- Inherit ADR-002 verbatim: **the port bind is the lock, the pidfile is advisory metadata** (not the lock). A stale pidfile (process dead, port free) is overwritten on next start; the bind decides. Atomic tmp-then-rename — recall FLOW's `run-pointer.ts` already does this; read it for the pattern.
- The fixed port is `:4317`. Health probe uses `127.0.0.1` directly (not `*.localhost`).
- Verify-and-adjust: the `.agentry/run/` dir may not exist — create it (don't assume).

## Acceptance
- A second `port-lock` bind on `:4317` fails with `EADDRINUSE` (the singleton proof, unit/integration).
- `pidfile` write→read round-trips `{ pid, port, startedAt }`; `process.kill(pid,0)` liveness distinguishes live vs stale; graceful shutdown removes it.
- Advances AC1 (single instance). Live AC1 (focus-or-start across real invocations) is verified in Phase 5.
