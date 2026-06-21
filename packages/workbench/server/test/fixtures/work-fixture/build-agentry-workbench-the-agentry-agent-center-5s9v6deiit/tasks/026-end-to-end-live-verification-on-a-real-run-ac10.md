---
title: end-to-end live verification on a real run (AC10 + final AC9, the
  never-green-only gate)
status: done
lockedBy: verifier
assignee: verifier
version: 7db2973ee6e8f478
---

---
phase: 5
kind: test
status: todo
deps: [11, 13, 17, 18, 19, 22, 23, 24, 25]
parallel_safe_with: []
---

## Goal
Drive the whole Agent Center **live** end-to-end on a real run after a plugin reload/restart, exercising every AC as observed behavior — the "never green-only" gate (AC10) — and confirm final full lockstep green at commit (AC9).

## Contract
- **owns:** (verification task — no new source files; may add an `e2e`/manual-verification checklist doc under `packages/workbench/` and tighten any seam-level glue found, but defers real fixes to the owning task)
- **exposes:** a pass/fail verdict that every AC1–AC10 holds live; the final committed dist + green `check-plugin`.
- **must NOT touch:** owning-task source as a *redesign* — a failure here routes back to the owning task; this task verifies and reports, it does not silently re-architect.

## Approach
- **Reload-gated (recalled, the highest risk §7.1):** a new command/server registers only on plugin reload/restart — so this MUST run after a restart, live, not in code. The riskiest unknown is the `*.localhost` + detached-spawn + focus-or-start loop (ADR-002) — **host-routing exactly as ADR-002, no path-routing fallback** (user gate decision).
- The live script (VISION §11): start a real decompose+verify run → `/agentry:workbench` launches the server → a **second** invocation focuses (no 2nd process, AC1) → Works lists runs, open routes to `<id>.localhost` (AC2) → Live renders the DAG no-overlap + typed edges + legend + hover (AC3) → open a node as Tiptap; in-progress read-only + lockedBy; Take over flips it (AC4) → span-comment lands 3-way-anchored in `.review/` + badges node (AC5) → stale-version save rejected; fresh edit bumps version (AC6) → agent edit live-updates over ws + before/after diff Accept/Reject/Iterate (AC7) → the five secondary pages render from real data (AC8).
- **Files-are-truth proof:** kill the server, confirm files persist, restart rebuilds everything from disk (doc 10 §6).
- Final: `pnpm --filter @agentry/workbench build` + `node scripts/check-plugin.mjs` **green** with both `dist-lockstep` rows, dist committed (AC9).
- A real concurrent agent write must be shown to reject a stale Workbench save; Take over flips a real `in-progress` lock (ADR-006 live note).

## Acceptance
- Every AC1–AC10 demonstrated **live** on a real run after a restart (not just code-green); files-are-truth confirmed (kill→persist→restart→rebuild).
- `check-plugin` green, both dist artifacts committed (AC9 final). Any failure is filed back to the owning task.
