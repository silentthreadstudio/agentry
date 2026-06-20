# Spec — @agentry/workbench (Agent Center V2)

**Intent.** A per-project local web app where a human interacts with a run's work —
read/edit/comment/approve the `.agentry/` artifacts and watch/steer the agents — rendered
and written over the FLOW v1 file seams. **Files are truth**; the Workbench is a live
transport + lock layer, never a second datastore.

**Authoritative brief:** [VISION.md](packages/workbench/VISION.md) — stack, IA, architecture, DECIDED.

## Acceptance criteria (observable)

1. `/agentry:workbench` opens a browser to the running per-project server; a 2nd invocation **focuses the same instance**.
2. **Works (home)** lists every run in `.agentry/work/` with status/shape/agents.
3. **Live** renders the run as a React Flow graph with **Dagre auto-layout** and *typed edges*.
4. A node opens as a **Tiptap document**; an `in-progress` artifact is **read-only with `lockedBy`**.

## Non-goals (V1)

- Channels/live-push (V2.1)
- Global cross-project scope
- Yjs co-editing
- Editing memory
