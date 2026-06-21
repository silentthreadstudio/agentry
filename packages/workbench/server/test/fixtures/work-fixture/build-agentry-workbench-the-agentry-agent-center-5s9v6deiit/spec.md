---
kind: spec
version: e03d06aef7aa613d
---

---
kind: feature
shape: decompose+verify
contract-of-record: packages/workbench/VISION.md
---

# Spec — @agentry/workbench (Agent Center V2)

**Intent.** A per-project local web app where a human interacts with a run's work —
read/edit/comment/approve the `.agentry/` artifacts and watch/steer the agents — rendered
and written over the FLOW v1 file seams. **Files are truth**; the Workbench is a live
transport + lock layer, never a second datastore.

**Authoritative brief:** `packages/workbench/VISION.md` (stack, IA, architecture — DECIDED, not re-litigated).
**Visual + interaction target:** `design/prototype-app.html`, `design/prototype-document.html` (a constraint, match them).
**Seams rendered over:** `.docs/internal/13-the-flow-mcp.md` (events.jsonl · task_status/lockedBy · .review sidecar · version hash).
**Design of record:** `.docs/internal/10-the-workbench.md`.

## Acceptance criteria (observable — verbatim from VISION §10)

1. `/agentry:workbench` opens a browser to the running per-project server; a 2nd invocation **focuses the same instance** (never a 2nd server).
2. **Works (home)** lists every run in `.agentry/work/` with status/shape/agents; opening one routes to `<id>.localhost:<port>` showing that work's **Live + Activity**.
3. **Live** renders the run as a React Flow graph with **Dagre auto-layout (no overlapping nodes)** + **typed edges** (derives/depends/blocks/satisfies distinct + legend); hover highlights a node's edges.
4. A node opens as a **Tiptap document**; an `in-progress` artifact is **read-only with `lockedBy`**; a `done`/`todo` one is editable; **Take over** flips the lock.
5. Selecting a span + commenting writes a **3-way-anchored entry to `.review/<gate>.json`**; shows in the rail + badges the node.
6. An **edit saved with a stale `version` is rejected** (optimistic concurrency); a fresh edit writes the file + bumps version.
7. An agent change to a watched file **live-updates the browser over the websocket** (no reload); a comment reply renders a **before/after diff** with Accept/Reject/Iterate.
8. **Activity / Agents / Tokens / Memory / Gates** each render from real data (event store · transcripts · `mem` store · `.review/`), dark + calm.
9. `pnpm --filter @agentry/workbench build` produces committed `plugin/workbench/` dist; **`check-plugin` green + validates the new bundle's dist-lockstep**.
10. Verified **live** (a real run, after the command launches it) — not just green in code.

## Non-goals (V1)
Channels/live-push (V2.1) · global cross-project scope · Yjs co-editing · time-travel replay · editing memory · becoming a datastore.

## Gate
Spec = VISION.md, confirmed as contract of record. Next: **Plan gate** — package structure, server architecture, build/dist pipeline, `*.localhost` routing, phasing, and ADRs. Build is phased (this is a multi-pass arc); the Plan proposes the phase boundaries.

